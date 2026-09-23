#!/usr/bin/env node
// Writes the Cash / Goal / Pipeline cache the Omnigent status line reads.
// Runs under launchd (com.calvin.omni-statusline-refresh). It spawns the same
// company-data-hub MCP server Claude Code uses, calls three read-only tools,
// and atomically replaces the cache. A leg that fails is left out rather than
// written as zero; if every leg fails the previous file is kept and the job
// exits non-zero so launchd and the LifeOS status page both show it.
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HUB_DIR = process.env.OMNI_STATUSLINE_HUB_DIR
  ?? path.join(homedir(), "scaleup-ai/mcp-servers/company-data-hub");
const HUB_ENTRY = process.env.OMNI_STATUSLINE_HUB_ENTRY ?? path.join(HUB_DIR, "src/index.js");
const DATA_PATH = process.env.OMNI_STATUSLINE_DATA ?? path.join(homedir(), ".claude/statusline-data.json");
const CALL_TIMEOUT_MS = Number(process.env.OMNI_STATUSLINE_TIMEOUT_MS ?? 60000);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function buildPayload({ cash, goal, stages }, nowEpoch) {
  const payload = { updated: nowEpoch, source: "company-data-hub" };
  const failed = [];
  const cashValue = num(cash?.value);
  if (cashValue === undefined) failed.push("cash"); else payload.cash = { value: cashValue };
  const g = goal?.value;
  const runrate = num(g?.lag?.recurringRevenueRunRate);
  const target = num(g?.config?.activeRung?.targetMonthlyRevenue);
  if (runrate === undefined || target === undefined) failed.push("goal");
  else payload.goal = { runrate, target };
  const list = Array.isArray(stages?.value) ? stages.value : null;
  if (!list) failed.push("pipeline");
  else payload.pipeline = {
    stages: list.map(({ stage, count, value }) => ({ stage, count, value })),
    target: num(g?.config?.pipelineGoal?.target),
  };
  if (failed.length === 3) throw new Error("no metrics: every data-hub call failed");
  if (failed.length) payload.failed = failed;
  return payload;
}

function openHub() {
  const child = spawn(process.execPath, [HUB_ENTRY], { cwd: HUB_DIR, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter(message); }
    }
  });
  child.stderr.resume();
  const send = (method, params, notify = false) => {
    const message = { jsonrpc: "2.0", method, params };
    if (notify) { child.stdin.write(JSON.stringify(message) + "\n"); return Promise.resolve(); }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, CALL_TIMEOUT_MS);
      pending.set(id, (reply) => { clearTimeout(timer); reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result); });
      child.stdin.write(JSON.stringify({ ...message, id }) + "\n");
    });
  };
  return { child, send };
}

async function callTool(hub, name, args) {
  const result = await hub.send("tools/call", { name, arguments: args });
  if (result?.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "tool error"}`);
  return JSON.parse(result?.content?.[0]?.text ?? "null");
}

async function main() {
  const hub = openHub();
  try {
    await hub.send("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "omni-statusline-refresh", version: "1" },
    });
    await hub.send("notifications/initialized", {}, true);
    const legs = await Promise.allSettled([
      callTool(hub, "get_cash_position", { entity: "scaleup" }),
      callTool(hub, "get_active_goal", {}),
      callTool(hub, "get_open_opps_by_stage", {}),
    ]);
    legs.forEach((leg, i) => {
      if (leg.status === "rejected") console.error(`[statusline-refresh] ${["cash", "goal", "pipeline"][i]} failed: ${leg.reason?.message}`);
    });
    const [cash, goal, stages] = legs.map((leg) => (leg.status === "fulfilled" ? leg.value : null));
    const payload = buildPayload({ cash, goal, stages }, Math.floor(Date.now() / 1000));
    await mkdir(path.dirname(DATA_PATH), { recursive: true });
    const temporary = `${DATA_PATH}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(payload) + "\n", "utf8");
    await rename(temporary, DATA_PATH);
    console.log(`[statusline-refresh] ok ${new Date().toISOString()} failed=${(payload.failed ?? []).join(",") || "none"}`);
    return payload.failed ? 2 : 0;
  } finally {
    hub.child.kill();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`[statusline-refresh] FAIL ${error.message}`);
    process.exit(1);
  });
}
