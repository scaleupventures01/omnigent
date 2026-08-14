import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.OMNIGENT_FORKED_UI_PORT ?? 6768);
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 6767;
const METRICS_HOST = "127.0.0.1";
const METRICS_PORT = 6789;
const METRICS_PATH = "/statusline";
const METRICS_TIMEOUT_MS = 3000;
const PROVIDER_TIMEOUT_MS = 8000;
const PROVIDER_CACHE_TTL_MS = 60_000;
const KIMI_LOCK_STALE_MS = 5_000;
const KIMI_LOCK_UPDATE_MS = KIMI_LOCK_STALE_MS / 2;
const KIMI_LOCK_RETRY_MS = 500;
const KIMI_LOCK_RETRY_COUNT = 120;
const USER_HOME = homedir();
const RATELIMITS_FILE = path.join(USER_HOME, ".claude", "statusline-ratelimits.json");
const KIMI_CREDENTIALS_FILE = path.join(
  USER_HOME,
  ".kimi-code",
  "credentials",
  "kimi-code.json",
);
const KIMI_OAUTH_LOCK_TARGET = path.join(USER_HOME, ".kimi-code", "oauth", "kimi-code");
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const STATIC_ROOT = "/Users/calvinwilliamsjr/Domains/infra/omnigent/omnigent/server/static/web-ui";
const INDEX_FILE = path.join(STATIC_ROOT, "index.html");
const PROXY_PREFIXES = ["/v1", "/api", "/auth", "/health"];

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".woff2", "font/woff2"],
  [".map", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
]);

function logError(context, error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[forked-ui] ${context}: ${message}`);
}

function parseRequestUrl(rawUrl) {
  return new URL(rawUrl ?? "/", `http://${LISTEN_HOST}:${LISTEN_PORT}`);
}

function isProxyPath(pathname) {
  return PROXY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function sendText(response, statusCode, body) {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    Connection: "close",
  });
  response.end(body);
}

function sendMetricsError(response) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }

  const body = '{"error":"Statusline metrics unavailable"}\n';
  response.writeHead(503, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end(body);
}

function serveStatuslineMetrics(request, response) {
  let settled = false;

  const fail = (context, error) => {
    if (settled) return;
    settled = true;
    logError(context, error);
    sendMetricsError(response);
  };

  const upstreamRequest = http.get(
    {
      hostname: METRICS_HOST,
      port: METRICS_PORT,
      path: METRICS_PATH,
    },
    (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 503;
      if (statusCode < 200 || statusCode >= 300) {
        upstreamResponse.resume();
        fail("metrics upstream returned a non-success status", new Error(`HTTP ${statusCode}`));
        return;
      }

      const chunks = [];
      upstreamResponse.on("data", (chunk) => {
        chunks.push(chunk);
      });
      upstreamResponse.on("end", () => {
        if (settled) return;
        settled = true;
        if (response.destroyed) return;

        const body = Buffer.concat(chunks);
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        response.end(body);
      });
      upstreamResponse.on("aborted", () => {
        fail("metrics upstream response was aborted", new Error("upstream response aborted"));
      });
      upstreamResponse.on("error", (error) => {
        fail("metrics upstream response failed", error);
      });
    },
  );

  upstreamRequest.setTimeout(METRICS_TIMEOUT_MS, () => {
    upstreamRequest.destroy(new Error(`metrics upstream timed out after ${METRICS_TIMEOUT_MS}ms`));
  });
  upstreamRequest.on("error", (error) => {
    fail("metrics upstream request failed", error);
  });

  request.on("aborted", () => {
    settled = true;
    upstreamRequest.destroy();
  });
}

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampPercent(value) {
  const numeric = finiteNumber(value);
  return numeric == null ? null : Math.min(100, Math.max(0, numeric));
}

function epochSeconds(value) {
  const numeric = finiteNumber(value);
  if (numeric != null) {
    return numeric > 10_000_000_000 ? numeric / 1000 : numeric;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function usageWindow(usedPercent, resetsAt) {
  const normalizedPercent = clampPercent(usedPercent);
  const normalizedReset = epochSeconds(resetsAt);
  if (normalizedPercent == null || normalizedReset == null) return null;
  return { usedPercent: normalizedPercent, resetsAt: normalizedReset };
}

function emptyProviderUsage() {
  return { fiveHour: null, weekly: null };
}

async function readClaudeUsage() {
  const raw = JSON.parse(await readFile(RATELIMITS_FILE, "utf8"));
  return {
    raw,
    usage: {
      fiveHour: usageWindow(
        raw?.five_hour?.used_percentage ?? raw?.five_hour?.pct,
        raw?.five_hour?.resets_at ?? raw?.five_hour?.resets,
      ),
      weekly: usageWindow(
        raw?.seven_day?.used_percentage ?? raw?.seven_day?.pct,
        raw?.seven_day?.resets_at ?? raw?.seven_day?.resets,
      ),
    },
  };
}

async function findCodexBinary() {
  const candidates = [
    process.env.CODEX_BIN,
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "codex")),
    path.join(USER_HOME, ".npm-global", "bin", "codex"),
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next installed location.
    }
  }
  throw new Error("Codex executable not found on PATH");
}

async function readCodexUsage() {
  const codexBinary = await findCodexBinary();

  return await new Promise((resolve, reject) => {
    const child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => {
      finish(new Error("Codex rate-limit request timed out"));
    }, PROVIDER_TIMEOUT_MS);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    }

    function send(payload) {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited before replying (${code ?? "unknown"})`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1 && message.result != null) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/rateLimits/read", params: {} });
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error("Codex rate-limit request failed"));
            return;
          }
          const limits = message.result?.rateLimits ?? message.result ?? {};
          const windows = [limits.primary, limits.secondary].filter(Boolean);
          const fiveHour =
            windows.find((window) => finiteNumber(window?.windowDurationMins) === 300) ??
            (limits.primary?.windowDurationMins == null ? limits.primary : null);
          const weekly =
            windows.find((window) => finiteNumber(window?.windowDurationMins) === 10_080) ??
            (limits.secondary?.windowDurationMins == null ? limits.secondary : null);
          finish(null, {
            fiveHour: usageWindow(fiveHour?.usedPercent, fiveHour?.resetsAt),
            weekly: usageWindow(weekly?.usedPercent, weekly?.resetsAt),
          });
          return;
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "omnigent-statusline",
          title: "Omnigent statusline",
          version: "1.0.0",
        },
      },
    });
  });
}

function credentialValue(credentials, snakeName, camelName) {
  const value = credentials?.[snakeName] ?? credentials?.[camelName];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function kimiCredentialsExpireAt(credentials) {
  return epochSeconds(credentials?.expires_at ?? credentials?.expiresAt);
}

function kimiCredentialsExpireIn(credentials) {
  return finiteNumber(credentials?.expires_in ?? credentials?.expiresIn);
}

function shouldRefreshKimiCredentials(credentials, nowSeconds = Date.now() / 1000) {
  const expiresAt = kimiCredentialsExpireAt(credentials);
  if (expiresAt == null) return false;
  const expiresIn = kimiCredentialsExpireIn(credentials);
  const threshold = Math.max(300, expiresIn != null && expiresIn > 0 ? expiresIn * 0.5 : 0);
  return expiresAt - nowSeconds < threshold;
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function reclaimStaleKimiCredentialLock(lockDirectory) {
  let first;
  try {
    first = await stat(lockDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  if (Date.now() - first.mtimeMs <= KIMI_LOCK_STALE_MS) return false;

  await new Promise((resolve) => setTimeout(resolve, 50));
  let second;
  try {
    second = await stat(lockDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const unchanged =
    first.dev === second.dev && first.ino === second.ino && first.mtimeMs === second.mtimeMs;
  if (!unchanged || Date.now() - second.mtimeMs <= KIMI_LOCK_STALE_MS) return false;

  const staleDirectory = `${lockDirectory}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lockDirectory, staleDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  await rmdir(staleDirectory).catch(() => {});
  return true;
}

async function acquireKimiCredentialLock() {
  const lockDirectory = `${KIMI_OAUTH_LOCK_TARGET}.lock`;
  await mkdir(path.dirname(KIMI_OAUTH_LOCK_TARGET), { recursive: true });
  await writeFile(KIMI_OAUTH_LOCK_TARGET, "", { flag: "a", mode: 0o600 });

  for (let attempt = 0; attempt < KIMI_LOCK_RETRY_COUNT; attempt += 1) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      const acquired = await stat(lockDirectory);
      const heartbeat = setInterval(() => {
        void stat(lockDirectory)
          .then((current) => {
            if (current.dev !== acquired.dev || current.ino !== acquired.ino) return;
            const now = new Date();
            return utimes(lockDirectory, now, now);
          })
          .catch(() => {});
      }, KIMI_LOCK_UPDATE_MS);
      heartbeat.unref();

      return async () => {
        clearInterval(heartbeat);
        try {
          const current = await stat(lockDirectory);
          if (current.dev === acquired.dev && current.ino === acquired.ino) {
            await rmdir(lockDirectory);
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimStaleKimiCredentialLock(lockDirectory)) continue;
      await new Promise((resolve) => setTimeout(resolve, KIMI_LOCK_RETRY_MS));
    }
  }
  throw new Error("Timed out waiting for the Kimi OAuth credential lock");
}

async function refreshKimiCredentials(credentials) {
  const refreshToken = credentialValue(credentials, "refresh_token", "refreshToken");
  if (!refreshToken) throw new Error("Kimi refresh token is unavailable");

  const refreshed = await fetchJson(KIMI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: KIMI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const accessToken = credentialValue(refreshed, "access_token", "accessToken");
  if (!accessToken) throw new Error("Kimi token refresh returned no access token");

  const next = {
    ...credentials,
    access_token: accessToken,
    refresh_token: credentialValue(refreshed, "refresh_token", "refreshToken") ?? refreshToken,
  };
  const expiresIn = finiteNumber(refreshed?.expires_in ?? refreshed?.expiresIn);
  if (expiresIn != null) next.expires_at = Math.floor(Date.now() / 1000 + expiresIn);

  const temporaryFile = `${KIMI_CREDENTIALS_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryFile, 0o600);
  await rename(temporaryFile, KIMI_CREDENTIALS_FILE);
  await chmod(KIMI_CREDENTIALS_FILE, 0o600);
  return next;
}

async function currentKimiCredentials() {
  let credentials = JSON.parse(await readFile(KIMI_CREDENTIALS_FILE, "utf8"));
  if (!shouldRefreshKimiCredentials(credentials)) return credentials;

  const releaseLock = await acquireKimiCredentialLock();
  try {
    credentials = JSON.parse(await readFile(KIMI_CREDENTIALS_FILE, "utf8"));
    if (!shouldRefreshKimiCredentials(credentials)) return credentials;
    return await refreshKimiCredentials(credentials);
  } finally {
    await releaseLock();
  }
}

async function readKimiUsage() {
  const credentials = await currentKimiCredentials();
  const accessToken = credentialValue(credentials, "access_token", "accessToken");
  if (!accessToken) throw new Error("Kimi access token is unavailable");

  const payload = await fetchJson(KIMI_USAGE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  const fiveHour = limits.find(
    (row) =>
      (Number(row?.window?.duration) === 5 && row?.window?.unit === "hour") ||
      (Number(row?.window?.duration) === 300 &&
        row?.window?.timeUnit === "TIME_UNIT_MINUTE"),
  );
  const weekly = limits.find((row) => row?.window?.unit === "week");
  const normalizeRow = (row) => {
    const detail = row?.detail ?? row;
    const limit = finiteNumber(detail?.limit);
    const remaining = finiteNumber(detail?.remaining);
    const used = finiteNumber(detail?.used) ??
      (limit != null && remaining != null ? limit - remaining : null);
    if (used == null || limit == null || limit <= 0) return null;
    return usageWindow(
      Math.round(Math.min(1, Math.max(0, used / limit)) * 100),
      row?.reset_at ?? detail?.resetTime,
    );
  };
  return {
    fiveHour: normalizeRow(fiveHour),
    weekly: normalizeRow(weekly) ?? normalizeRow(payload?.usage),
  };
}

const providerCache = {
  value: null,
  expiresAt: 0,
  inFlight: null,
};

export async function collectProviderRateLimits() {
  if (providerCache.value != null && Date.now() < providerCache.expiresAt) {
    return providerCache.value;
  }
  if (providerCache.inFlight != null) return await providerCache.inFlight;

  providerCache.inFlight = (async () => {
    const providers = {
      claude: emptyProviderUsage(),
      chatgpt: emptyProviderUsage(),
      kimi: emptyProviderUsage(),
    };
    let claudeLegacy = null;
    const collectors = [readClaudeUsage(), readCodexUsage(), readKimiUsage()];
    const results = await Promise.allSettled(collectors);

    if (results[0].status === "fulfilled") {
      providers.claude = results[0].value.usage;
      claudeLegacy = results[0].value.raw;
    } else {
      logError("Claude rate-limit collector failed", results[0].reason);
    }
    if (results[1].status === "fulfilled") providers.chatgpt = results[1].value;
    else logError("ChatGPT rate-limit collector failed", results[1].reason);
    if (results[2].status === "fulfilled") providers.kimi = results[2].value;
    else logError("Kimi rate-limit collector failed", results[2].reason);

    const value = {
      ...(claudeLegacy ?? {}),
      capturedAtMs: Date.now(),
      providers,
      claudeLegacy,
    };
    providerCache.value = value;
    providerCache.expiresAt = Date.now() + PROVIDER_CACHE_TTL_MS;
    return value;
  })();

  try {
    return await providerCache.inFlight;
  } finally {
    providerCache.inFlight = null;
  }
}

async function serveRateLimits(_request, response) {
  const payload = await collectProviderRateLimits();
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function proxyHttpRequest(request, response, targetPath) {
  const headers = {
    ...request.headers,
    host: `${BACKEND_HOST}:${BACKEND_PORT}`,
  };

  const upstreamRequest = http.request(
    {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      method: request.method,
      path: targetPath,
      headers,
    },
    (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      const statusMessage = upstreamResponse.statusMessage;

      try {
        if (statusMessage) {
          response.writeHead(statusCode, statusMessage, upstreamResponse.rawHeaders);
        } else {
          response.writeHead(statusCode, upstreamResponse.rawHeaders);
        }
      } catch (error) {
        logError("could not forward backend response headers", error);
        upstreamResponse.destroy();
        sendText(response, 502, "Bad Gateway\n");
        return;
      }

      upstreamResponse.on("error", (error) => {
        logError("backend response stream failed", error);
        response.destroy(error);
      });
      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.on("error", (error) => {
    logError("backend HTTP request failed", error);
    sendText(response, 502, "Bad Gateway\n");
  });

  request.on("aborted", () => {
    upstreamRequest.destroy();
  });
  request.on("error", (error) => {
    logError("client request stream failed", error);
    upstreamRequest.destroy(error);
  });
  request.pipe(upstreamRequest);
}

function pathInsideStaticRoot(candidate) {
  return candidate === STATIC_ROOT || candidate.startsWith(`${STATIC_ROOT}${path.sep}`);
}

async function resolveStaticFile(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    const error = new Error("request path has invalid percent encoding");
    error.statusCode = 400;
    throw error;
  }

  if (decodedPath.includes("\0")) {
    const error = new Error("request path contains a null byte");
    error.statusCode = 400;
    throw error;
  }

  const relativePath = decodedPath.replace(/^\/+/, "");
  const candidate = path.resolve(STATIC_ROOT, relativePath);
  if (!pathInsideStaticRoot(candidate)) {
    return INDEX_FILE;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
      throw error;
    }
  }

  return INDEX_FILE;
}

async function serveStaticRequest(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendText(response, 405, "Method Not Allowed\n");
    return;
  }

  const filePath = await resolveStaticFile(pathname);
  const fileStat = await stat(filePath);
  const contentType = CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";

  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fileStat.size,
    "X-Content-Type-Options": "nosniff",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const fileStream = createReadStream(filePath);
  fileStream.on("error", (error) => {
    logError(`static file stream failed for ${filePath}`, error);
    response.destroy(error);
  });
  fileStream.pipe(response);
}

async function handleHttpRequest(request, response) {
  let parsed;
  try {
    parsed = parseRequestUrl(request.url);
  } catch (error) {
    logError("invalid request URL", error);
    sendText(response, 400, "Bad Request\n");
    return;
  }

  if (isProxyPath(parsed.pathname)) {
    proxyHttpRequest(request, response, `${parsed.pathname}${parsed.search}`);
    return;
  }

  if (request.method === "GET" && parsed.pathname === "/__metrics/statusline") {
    serveStatuslineMetrics(request, response);
    return;
  }

  if (request.method === "GET" && parsed.pathname === "/__metrics/ratelimits") {
    await serveRateLimits(request, response);
    return;
  }

  try {
    await serveStaticRequest(request, response, parsed.pathname);
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    logError("static request failed", error);
    sendText(response, statusCode, statusCode === 400 ? "Bad Request\n" : "Internal Server Error\n");
  }
}

function writeSocketResponse(socket, statusLine) {
  if (!socket.destroyed) {
    socket.end(`${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

function buildUpgradeRequest(request, targetPath) {
  const headerLines = [];
  let sawHost = false;

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name.toLowerCase() === "host") {
      headerLines.push(`${name}: ${BACKEND_HOST}:${BACKEND_PORT}`);
      sawHost = true;
    } else {
      headerLines.push(`${name}: ${value}`);
    }
  }

  if (!sawHost) {
    headerLines.push(`Host: ${BACKEND_HOST}:${BACKEND_PORT}`);
  }

  const method = request.method ?? "GET";
  return `${method} ${targetPath} HTTP/${request.httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`;
}

function proxyWebSocket(request, clientSocket, head, targetPath) {
  clientSocket.pause();
  let connected = false;
  const upstreamSocket = net.createConnection({
    host: BACKEND_HOST,
    port: BACKEND_PORT,
  });

  upstreamSocket.once("connect", () => {
    connected = true;
    upstreamSocket.write(buildUpgradeRequest(request, targetPath));
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    clientSocket.resume();
  });

  upstreamSocket.on("error", (error) => {
    logError("backend WebSocket connection failed", error);
    if (!connected) {
      writeSocketResponse(clientSocket, "HTTP/1.1 502 Bad Gateway");
    } else {
      clientSocket.destroy();
    }
  });

  clientSocket.on("error", (error) => {
    logError("client WebSocket connection failed", error);
    upstreamSocket.destroy();
  });

  clientSocket.on("close", () => {
    upstreamSocket.destroy();
  });
  upstreamSocket.on("close", () => {
    clientSocket.destroy();
  });
}

const server = http.createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error) => {
    logError("unhandled HTTP request failure", error);
    sendText(response, 500, "Internal Server Error\n");
  });
});

server.on("upgrade", (request, socket, head) => {
  let parsed;
  try {
    parsed = parseRequestUrl(request.url);
  } catch (error) {
    logError("invalid WebSocket request URL", error);
    writeSocketResponse(socket, "HTTP/1.1 400 Bad Request");
    return;
  }

  if (!isProxyPath(parsed.pathname)) {
    writeSocketResponse(socket, "HTTP/1.1 404 Not Found");
    return;
  }

  proxyWebSocket(request, socket, head, `${parsed.pathname}${parsed.search}`);
});

server.on("clientError", (error, socket) => {
  logError("malformed client request", error);
  const statusLine = error.code === "HPE_HEADER_OVERFLOW"
    ? "HTTP/1.1 431 Request Header Fields Too Large"
    : "HTTP/1.1 400 Bad Request";
  writeSocketResponse(socket, statusLine);
});

server.on("error", (error) => {
  logError("server error", error);
  process.exitCode = 1;
});

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`Forked Omnigent UI listening at http://${LISTEN_HOST}:${LISTEN_PORT}`);
  });
}
