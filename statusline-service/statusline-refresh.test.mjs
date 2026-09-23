import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPayload } from "./statusline-refresh.mjs";

const CASH = { value: 5934.92, freshness: "fresh" };
const GOAL = { value: {
  config: { activeRung: { targetMonthlyRevenue: 10000 }, pipelineGoal: { target: 275000 } },
  lag: { recurringRevenueRunRate: 7500 },
} };
const STAGES = { value: [
  { stage: "LEAD", count: 757, value: 1085400 },
  { stage: "PROPOSAL_SENT", count: 4, value: 23033 },
  { stage: "REPLIED_INTERESTED", count: 3, value: 5950 },
] };

test("the payload carries exactly the fields the Omnigent status line reads", () => {
  const p = buildPayload({ cash: CASH, goal: GOAL, stages: STAGES }, 1790180000);
  assert.deepEqual(p.cash, { value: 5934.92 });
  assert.deepEqual(p.goal, { runrate: 7500, target: 10000 });
  assert.equal(p.pipeline.target, 275000);
  assert.deepEqual(p.pipeline.stages.map((s) => s.stage), ["LEAD", "PROPOSAL_SENT", "REPLIED_INTERESTED"]);
  assert.equal(p.updated, 1790180000);
});

test("a failed leg is omitted, never written as zero", () => {
  const p = buildPayload({ cash: null, goal: GOAL, stages: STAGES }, 1);
  assert.equal(p.cash, undefined);
  assert.deepEqual(p.failed, ["cash"]);
});

test("every leg failing is an error, so the last good file is never replaced", () => {
  assert.throws(() => buildPayload({ cash: null, goal: null, stages: null }, 1), /no metrics/);
});
