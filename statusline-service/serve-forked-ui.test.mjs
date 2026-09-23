import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { __providerUsageTest } from "./serve-forked-ui.mjs";

const {
  createProviderRateLimitCollector,
  loadOmnigentZaiSecret,
  normalizeGlmUsagePayload,
  readGlmUsage,
} = __providerUsageTest;

const window = (usedPercent) => ({ usedPercent, resetsAt: 1_800_000_000 });
const usage = (fiveHour, weekly) => ({ fiveHour, weekly });

function collectorOverrides({
  claude = async () => ({ raw: {}, usage: usage(window(11), window(7)) }),
  chatgpt = async () => usage(null, window(42)),
  glm = async () => usage(null, null),
} = {}) {
  return { claude, chatgpt, glm };
}

test("rate-limits payload exposes exactly the claude/chatgpt/glm providers with their own data", async () => {
  const collect = createProviderRateLimitCollector({
    ttlMs: 0,
    now: () => 1_000,
    collectors: collectorOverrides({
      glm: async () => usage(window(5), window(9)),
    }),
  });

  const payload = await collect();
  assert.deepEqual(Object.keys(payload.providers).sort(), ["chatgpt", "claude", "glm"]);
  assert.deepEqual(payload.providers.claude, usage(window(11), window(7)));
  assert.deepEqual(payload.providers.chatgpt, usage(null, window(42)));
  assert.deepEqual(payload.providers.glm, usage(window(5), window(9)));
});

test("known-negative control: a failing GLM source degrades to n/a and never inherits another provider's usage", async () => {
  const errors = [];
  const collect = createProviderRateLimitCollector({
    ttlMs: 0,
    now: () => 1_000,
    collectors: collectorOverrides({ glm: async () => { throw new Error("no GLM quota source"); } }),
    onError: (context) => errors.push(context),
  });

  const payload = await collect();

  assert.deepEqual(payload.providers.glm, { fiveHour: null, weekly: null });
  assert.deepEqual(payload.providers.claude, usage(window(11), window(7)));
  assert.deepEqual(payload.providers.chatgpt, usage(null, window(42)));
  assert.equal(errors.some((message) => String(message).includes("GLM")), true);
  // The retired Kimi provider must never reappear in the payload — neither
  // under its own name nor relabeled as GLM.
  assert.equal(Object.keys(payload.providers).includes("kimi"), false);
  assert.doesNotMatch(JSON.stringify(payload), /"kimi"/);
});

test("an empty GLM collector stays empty regardless of cached legacy Claude payload", async () => {
  const collect = createProviderRateLimitCollector({
    ttlMs: 0,
    now: () => 1_000,
    collectors: collectorOverrides(),
  });

  const payload = await collect();
  assert.deepEqual(payload.providers.glm, { fiveHour: null, weekly: null });
  assert.equal(Object.keys(payload.providers).includes("kimi"), false);
});

const glmLimitsPayload = () => ({
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        percentage: 11,
        nextResetTime: 1_789_963_400_732,
        currentValue: 3168,
        usage: 28000,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        percentage: 5,
        nextResetTime: 1_790_433_863_997,
        currentValue: 8315,
        usage: 140000,
      },
    ],
  },
});

const glmFetcher = (payload, captured = []) => async (token) => {
  captured.push(token);
  return payload;
};

test("known-negative control: GLM collector surfaces real five-hour and weekly windows where the retired null stub returned nothing", async () => {
  const captured = [];
  const usage = await readGlmUsage({
    env: { ZAI_API_KEY: "test-zai-token" },
    loadSecret: async () => {
      throw new Error("keychain must not be consulted when ZAI_API_KEY is set");
    },
    fetchPayload: glmFetcher(glmLimitsPayload(), captured),
  });

  assert.deepEqual(usage, {
    fiveHour: { usedPercent: 11, resetsAt: 1_789_963_400.732 },
    weekly: { usedPercent: 5, resetsAt: 1_790_433_863.997 },
  });
  assert.deepEqual(captured, ["test-zai-token"]);
});

test("normalizeGlmUsagePayload maps CREDIT_LIMIT unit 3 to the five-hour window and unit 6 to the weekly window", () => {
  const usage = normalizeGlmUsagePayload(glmLimitsPayload());
  assert.deepEqual(usage.fiveHour, { usedPercent: 11, resetsAt: 1_789_963_400.732 });
  assert.deepEqual(usage.weekly, { usedPercent: 5, resetsAt: 1_790_433_863.997 });

  const partial = normalizeGlmUsagePayload({
    data: {
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, percentage: "42", nextResetTime: 1_789_963_400_732 },
        { type: "TOKENS_LIMIT", unit: 6, percentage: 99, nextResetTime: 1 },
      ],
    },
  });
  assert.deepEqual(partial.fiveHour, { usedPercent: 42, resetsAt: 1_789_963_400.732 });
  assert.deepEqual(partial.weekly, null);
});

test("normalizeGlmUsagePayload fails closed on missing, malformed, or non-numeric quota rows", () => {
  for (const payload of [
    null,
    {},
    { data: null },
    { data: { limits: "nope" } },
    { data: { limits: [] } },
    { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3 }] } },
    { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: "abc", nextResetTime: 1 }] } },
    { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 11 }] } },
    { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 11, nextResetTime: "not-a-time" }] } },
  ]) {
    const usage = normalizeGlmUsagePayload(payload);
    assert.deepEqual(usage, { fiveHour: null, weekly: null }, JSON.stringify(payload));
  }
});

test("readGlmUsage falls back to the omnigent secret loader and fails closed when no credential exists", async () => {
  const captured = [];
  const usage = await readGlmUsage({
    env: {},
    loadSecret: async () => "keychain-token",
    fetchPayload: glmFetcher(glmLimitsPayload(), captured),
  });
  assert.deepEqual(captured, ["keychain-token"]);
  assert.equal(usage.fiveHour.usedPercent, 11);

  await assert.rejects(
    readGlmUsage({
      env: { ZAI_API_KEY: "   " },
      loadSecret: async () => null,
      fetchPayload: async () => glmLimitsPayload(),
    }),
    /credential is unavailable/,
  );
});

test("GLM collector failure inside the aggregated payload stays null and never borrows claude/chatgpt windows", async () => {
  const errors = [];
  const collect = createProviderRateLimitCollector({
    ttlMs: 0,
    now: () => 1_000,
    collectors: {
      claude: async () => ({ raw: {}, usage: usage(window(11), window(7)) }),
      chatgpt: async () => usage(null, window(42)),
      glm: () =>
        readGlmUsage({
          env: {},
          loadSecret: async () => null,
          fetchPayload: async () => glmLimitsPayload(),
        }),
    },
    onError: (context) => errors.push(context),
  });

  const payload = await collect();
  assert.deepEqual(payload.providers.glm, { fiveHour: null, weekly: null });
  assert.deepEqual(payload.providers.claude, usage(window(11), window(7)));
  assert.deepEqual(payload.providers.chatgpt, usage(null, window(42)));
  assert.equal(errors.some((message) => String(message).includes("GLM")), true);
});

test("loadOmnigentZaiSecret reads the omnigent file backend and honors OMNIGENT_DISABLE_KEYRING", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glm-secrets-"));
  try {
    const secretsFile = path.join(directory, "secrets.json");
    await writeFile(secretsFile, `${JSON.stringify({ zai: "file-backend-token" })}\n`);

    assert.equal(
      await loadOmnigentZaiSecret({ pythonCandidates: [], secretsFile }),
      "file-backend-token",
    );
    assert.equal(
      await loadOmnigentZaiSecret({ pythonCandidates: [], secretsFile: path.join(directory, "missing.json") }),
      null,
    );

    const previous = process.env.OMNIGENT_DISABLE_KEYRING;
    process.env.OMNIGENT_DISABLE_KEYRING = "1";
    try {
      assert.equal(
        await loadOmnigentZaiSecret({
          pythonCandidates: ["/bin/echo"],
          secretsFile,
        }),
        "file-backend-token",
      );
    } finally {
      if (previous === undefined) delete process.env.OMNIGENT_DISABLE_KEYRING;
      else process.env.OMNIGENT_DISABLE_KEYRING = previous;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
