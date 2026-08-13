import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 6768;
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 6767;
const METRICS_HOST = "127.0.0.1";
const METRICS_PORT = 6789;
const METRICS_PATH = "/statusline";
const METRICS_TIMEOUT_MS = 3000;
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

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Forked Omnigent UI listening at http://${LISTEN_HOST}:${LISTEN_PORT}`);
});
