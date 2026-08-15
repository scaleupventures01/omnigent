import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { __providerUsageTest } from "./serve-forked-ui.mjs";

const {
  createProviderRateLimitCollector,
  normalizeClaudeUsage,
  normalizeCodexRateLimits,
  normalizeKimiUsagePayload,
  parseCodexJsonLines,
  reclaimStaleKimiCredentialLock,
  redactProviderSecrets,
  resolveCodexBinary,
  shouldRefreshKimiCredentials,
} = __providerUsageTest;

const FIVE_HOURS = 300;
const ONE_WEEK = 10_080;

test("normalizes Claude's live cache schema", () => {
  assert.deepEqual(
    normalizeClaudeUsage({
      five_hour: { used_percentage: 72, resets_at: 1_800_000_000 },
      seven_day: { used_percentage: 31, resets_at: 1_800_086_400 },
    }),
    {
      fiveHour: { usedPercent: 72, resetsAt: 1_800_000_000 },
      weekly: { usedPercent: 31, resetsAt: 1_800_086_400 },
    },
  );
});

test("parses Codex newline JSON frames and maps windows by duration", () => {
  const first = parseCodexJsonLines("", '{"id":1,"result":{}}\n{"id":2');
  assert.deepEqual(first.messages, [{ id: 1, result: {} }]);
  assert.equal(first.remainder, '{"id":2');

  const second = parseCodexJsonLines(
    first.remainder,
    ',"result":{"rateLimits":{"primary":{"windowDurationMins":10080,"usedPercent":40,"resetsAt":1800086400},"secondary":null}}}\n',
  );
  assert.equal(second.remainder, "");
  assert.equal(second.messages.length, 1);
  assert.deepEqual(normalizeCodexRateLimits(second.messages[0].result.rateLimits), {
    fiveHour: null,
    weekly: { usedPercent: 40, resetsAt: 1_800_086_400 },
  });

  assert.deepEqual(
    normalizeCodexRateLimits({
      primary: { windowDurationMins: FIVE_HOURS, usedPercent: 18, resetsAt: 1_800_000_000 },
      secondary: { windowDurationMins: ONE_WEEK, usedPercent: 44, resetsAt: 1_800_086_400 },
    }),
    {
      fiveHour: { usedPercent: 18, resetsAt: 1_800_000_000 },
      weekly: { usedPercent: 44, resetsAt: 1_800_086_400 },
    },
  );
});

test("resolves Codex from the stable user install when launchd PATH excludes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omnigent-codex-bin-"));
  const userBinary = path.join(root, ".local", "bin", "codex");
  try {
    await mkdir(path.dirname(userBinary), { recursive: true });
    await writeFile(userBinary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(userBinary, 0o700);

    assert.equal(
      await resolveCodexBinary({
        env: { HOME: root, PATH: "/usr/bin:/bin" },
      }),
      userBinary,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prefers the explicit Omnigent Codex binary override", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omnigent-codex-override-"));
  const overrideBinary = path.join(root, "custom-codex");
  const userBinary = path.join(root, ".local", "bin", "codex");
  try {
    await mkdir(path.dirname(userBinary), { recursive: true });
    await writeFile(overrideBinary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(userBinary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(overrideBinary, 0o700);
    await chmod(userBinary, 0o700);

    assert.equal(
      await resolveCodexBinary({
        env: {
          HOME: root,
          PATH: path.dirname(userBinary),
          OMNI_CODEX_BIN: overrideBinary,
        },
      }),
      overrideBinary,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes Kimi's current nested detail and top-level weekly usage", () => {
  assert.deepEqual(
    normalizeKimiUsagePayload({
      limits: [
        {
          window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "1000", remaining: "250", resetTime: "1800000000" },
        },
      ],
      usage: { limit: "5000", remaining: "3200", resetTime: "1800086400" },
    }),
    {
      fiveHour: { usedPercent: 75, resetsAt: 1_800_000_000 },
      weekly: { usedPercent: 36, resetsAt: 1_800_086_400 },
    },
  );
});

test("refreshes Kimi credentials inside max(300, expires_in * 0.5)", () => {
  const now = 1_800_000_000;
  assert.equal(
    shouldRefreshKimiCredentials({ expires_at: now + 299, expires_in: 100 }, now),
    true,
  );
  assert.equal(
    shouldRefreshKimiCredentials({ expires_at: now + 301, expires_in: 100 }, now),
    false,
  );
  assert.equal(
    shouldRefreshKimiCredentials({ expires_at: now + 1_799, expires_in: 3600 }, now),
    true,
  );
  assert.equal(
    shouldRefreshKimiCredentials({ expires_at: now + 1_801, expires_in: 3600 }, now),
    false,
  );
});

test("respects a fresh Kimi lock and recovers a stale lock without changing credential mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omnigent-kimi-lock-"));
  const credentialFile = path.join(root, "credentials", "kimi-code.json");
  const lockDirectory = path.join(root, "oauth", "kimi-code.lock");
  try {
    await mkdir(path.dirname(credentialFile), { recursive: true });
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(credentialFile, '{"access_token":"test-only"}\n', { mode: 0o600 });
    await chmod(credentialFile, 0o600);

    assert.equal(
      await reclaimStaleKimiCredentialLock(lockDirectory, {
        nowMs: Date.now(),
        staleMs: 5_000,
        settle: async () => {},
      }),
      false,
    );
    assert.equal((await stat(lockDirectory)).isDirectory(), true);

    const staleDate = new Date(Date.now() - 10_000);
    await utimes(lockDirectory, staleDate, staleDate);
    assert.equal(
      await reclaimStaleKimiCredentialLock(lockDirectory, {
        nowMs: Date.now(),
        staleMs: 5_000,
        settle: async () => {},
      }),
      true,
    );
    await assert.rejects(stat(lockDirectory), { code: "ENOENT" });
    assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coalesces concurrent provider collection and reuses the fresh cache", async () => {
  let calls = 0;
  let releaseClaude;
  const claudePending = new Promise((resolve) => {
    releaseClaude = resolve;
  });
  const collect = createProviderRateLimitCollector({
    ttlMs: 60_000,
    now: () => 1_800_000_000_000,
    collectors: {
      claude: async () => {
        calls += 1;
        return await claudePending;
      },
      chatgpt: async () => ({ fiveHour: null, weekly: null }),
      kimi: async () => ({ fiveHour: null, weekly: null }),
    },
    onError: () => {},
  });

  const first = collect();
  const second = collect();
  assert.equal(calls, 1);
  releaseClaude({
    raw: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 } },
    usage: { fiveHour: { usedPercent: 12, resetsAt: 1_800_000_000 }, weekly: null },
  });
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.strictEqual(await collect(), a);
  assert.equal(calls, 1);
});

test("isolates one provider failure while preserving successful providers", async () => {
  const collect = createProviderRateLimitCollector({
    ttlMs: 60_000,
    now: () => 1_800_000_000_000,
    collectors: {
      claude: async () => ({
        raw: {},
        usage: { fiveHour: { usedPercent: 10, resetsAt: 1_800_000_000 }, weekly: null },
      }),
      chatgpt: async () => ({
        fiveHour: { usedPercent: 20, resetsAt: 1_800_000_000 },
        weekly: { usedPercent: 30, resetsAt: 1_800_086_400 },
      }),
      kimi: async () => {
        throw new Error("Kimi unavailable");
      },
    },
    onError: () => {},
  });

  const result = await collect();
  assert.deepEqual(result.providers.claude.fiveHour, {
    usedPercent: 10,
    resetsAt: 1_800_000_000,
  });
  assert.deepEqual(result.providers.chatgpt.weekly, {
    usedPercent: 30,
    resetsAt: 1_800_086_400,
  });
  assert.deepEqual(result.providers.kimi, { fiveHour: null, weekly: null });
});

test("redacts access and refresh tokens from provider failures", () => {
  const raw =
    "request failed: Authorization: Bearer access-secret access_token=access-secret refresh_token=refresh-secret";
  const safe = redactProviderSecrets(raw);
  assert.doesNotMatch(safe, /access-secret|refresh-secret/);
  assert.match(safe, /\[redacted\]/);
});
