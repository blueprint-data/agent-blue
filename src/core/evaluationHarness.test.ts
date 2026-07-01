import { describe, expect, it } from "vitest";
import type {
  AgentExecutionTurn,
  ExecutionTraceEvent,
  GoldenEvalCase,
  ToolExecutionRecord
} from "./types.js";
import {
  DEFAULT_GOLDEN_EVAL_CASES,
  scoreEvaluationTurn
} from "./evaluationHarness.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTurn(overrides: Partial<AgentExecutionTurn> = {}): AgentExecutionTurn {
  const now = new Date().toISOString();
  return {
    id: "turn_test",
    tenantId: "test-tenant",
    conversationId: "conv_test",
    source: "cli",
    rawUserText: "test prompt",
    promptText: "test prompt",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as AgentExecutionTurn;
}

function makeEvent(overrides: Partial<ExecutionTraceEvent> = {}): ExecutionTraceEvent {
  const now = new Date().toISOString();
  return {
    id: "evt_test",
    turnId: "turn_test",
    tenantId: "test-tenant",
    conversationId: "conv_test",
    type: "planner.decision",
    level: "info",
    message: "test",
    createdAt: now,
    ...overrides
  } as ExecutionTraceEvent;
}

function makeToolExec(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: "tool_test",
    turnId: "turn_test",
    tenantId: "test-tenant",
    conversationId: "conv_test",
    cacheKey: "ck_test",
    tool: "warehouse.query",
    input: {},
    status: "ok",
    durationMs: 100,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as ToolExecutionRecord;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DEFAULT_GOLDEN_EVAL_CASES", () => {
  it("contains at least 5 analytics eval cases", () => {
    expect(DEFAULT_GOLDEN_EVAL_CASES.length).toBeGreaterThanOrEqual(5);
  });

  it("every case has an id and prompt", () => {
    for (const testCase of DEFAULT_GOLDEN_EVAL_CASES) {
      expect(testCase.id).toBeTruthy();
      expect(testCase.prompt).toBeTruthy();
    }
  });
});

describe("scoreEvaluationTurn — well-executed turn", () => {
  it("scores above 70 for a clean execution with required tools, expected SQL, and answer", () => {
    const goldenCase: GoldenEvalCase = {
      id: "revenue-by-region",
      prompt: "What was revenue by region this quarter?",
      expectedSqlPatterns: ["SUM(", "GROUP BY", "region"],
      forbiddenSqlPatterns: ["DROP", "DELETE", "UPDATE", "INSERT"],
      requiredTools: ["dbt.listModels", "warehouse.query"],
      forbiddenTools: ["tenantMemory.save"],
      requireAnswer: true
    };

    const createdAt = new Date();
    const completedAt = new Date(createdAt.getTime() + 5000); // 5s latency

    const turn = makeTurn({
      createdAt: createdAt.toISOString(),
      updatedAt: completedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      assistantText: "Revenue by region this quarter: North America $1.2M, Europe $800K, APAC $400K.",
      events: [
        makeEvent({ type: "planner.decision", message: "Step 1: list models" }),
        makeEvent({ type: "planner.decision", message: "Step 2: query revenue" }),
        makeEvent({ type: "planner.decision", message: "Step 3: final answer" })
      ],
      toolExecutions: [
        makeToolExec({ tool: "dbt.listModels", input: {} }),
        makeToolExec({
          tool: "warehouse.query",
          input: { sql: "SELECT region, SUM(revenue) FROM fct_sales GROUP BY region LIMIT 100" }
        })
      ]
    });

    const result = scoreEvaluationTurn(turn, goldenCase);

    expect(result.score).toBeGreaterThan(70);
    expect(result.fallback).toBe(false);
    expect(result.breakdown.planner).toBe(15); // 3 attempts × 5
    expect(result.breakdown.tools).toBe(20); // base 10 + 2 required × 5
    expect(result.breakdown.sqlSafety).toBeGreaterThanOrEqual(20); // base 10 + at least 2 patterns
    expect(result.breakdown.correctnessSignals).toBe(20); // has answer + required
    expect(result.breakdown.latency).toBe(10); // under 8s
    expect(result.matchedExpectedSqlPatterns.length).toBeGreaterThanOrEqual(2);
    expect(result.violatedForbiddenSqlPatterns).toHaveLength(0);
    expect(result.missingRequiredTools).toHaveLength(0);
    expect(result.violatedForbiddenTools).toHaveLength(0);
  });
});

describe("scoreEvaluationTurn — poor execution", () => {
  it("scores below 50 when tools are missing, SQL contains forbidden patterns, and fallback occurs", () => {
    const goldenCase: GoldenEvalCase = {
      id: "revenue-by-region",
      prompt: "What was revenue by region this quarter?",
      expectedSqlPatterns: ["SUM(", "GROUP BY", "region"],
      forbiddenSqlPatterns: ["DROP", "DELETE", "UPDATE", "INSERT"],
      requiredTools: ["dbt.listModels", "warehouse.query"],
      forbiddenTools: ["tenantMemory.save"],
      requireAnswer: true
    };

    const createdAt = new Date();
    const completedAt = new Date(createdAt.getTime() + 20000); // 20s latency

    const turn = makeTurn({
      createdAt: createdAt.toISOString(),
      updatedAt: completedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      assistantText: "I could not reach a reliable final answer after multiple tool attempts.",
      events: [
        makeEvent({ type: "planner.decision", message: "Step 1: attempt" })
      ],
      toolExecutions: [
        makeToolExec({ tool: "tenantMemory.save", input: { content: "test" } }),
        makeToolExec({
          tool: "warehouse.query",
          input: { sql: "DELETE FROM fct_sales WHERE region = 'EU'" },
          status: "error",
          error: "Permission denied"
        })
      ]
    });

    const result = scoreEvaluationTurn(turn, goldenCase);

    expect(result.score).toBeLessThan(50);
    expect(result.fallback).toBe(true);
    expect(result.breakdown.planner).toBe(0); // 1 attempt = 5, fallback penalty = -10 → 0
    expect(result.breakdown.tools).toBe(0); // base 10 - forbidden 10 - error 5 = -5 → 0
    expect(result.breakdown.sqlSafety).toBe(0); // forbidden SQL drops it to 0
    expect(result.breakdown.latency).toBe(2); // 20s falls in 15-30s bucket
    expect(result.violatedForbiddenSqlPatterns).toContain("DELETE");
    expect(result.missingRequiredTools).toContain("dbt.listModels");
    expect(result.violatedForbiddenTools).toContain("tenantMemory.save");
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe("scoreEvaluationTurn — edge cases", () => {
  it("returns 0 score for a completely empty turn with no data", () => {
    const goldenCase: GoldenEvalCase = {
      id: "empty-test",
      prompt: "Empty",
      requireAnswer: true
    };

    const turn = makeTurn({
      assistantText: undefined,
      events: [],
      toolExecutions: []
    });

    const result = scoreEvaluationTurn(turn, goldenCase);
    expect(result.score).toBe(0);
    expect(result.fallback).toBe(true);
    expect(result.breakdown.planner).toBe(0);
    expect(result.breakdown.tools).toBe(0);
    expect(result.breakdown.sqlSafety).toBe(0);
    expect(result.breakdown.correctnessSignals).toBe(0);
    expect(result.breakdown.latency).toBe(0);
  });

  it("caps planner score at 20 and penalizes too many attempts", () => {
    const goldenCase: GoldenEvalCase = {
      id: "planner-cap",
      prompt: "Test planner cap"
    };

    const events = Array.from({ length: 8 }, (_, i) =>
      makeEvent({ type: "planner.decision", message: `Step ${i + 1}` })
    );

    const turn = makeTurn({ events, assistantText: "Test answer to avoid fallback penalty." });
    const result = scoreEvaluationTurn(turn, goldenCase);

    // 8 attempts: base would be 20, but >6 penalty removes 8 → 12
    expect(result.breakdown.planner).toBe(12);
  });

  it("gives partial latency score between 8s and 15s", () => {
    const goldenCase: GoldenEvalCase = {
      id: "latency-partial",
      prompt: "Test latency"
    };

    const createdAt = new Date();
    const completedAt = new Date(createdAt.getTime() + 12000); // 12s

    const turn = makeTurn({
      createdAt: createdAt.toISOString(),
      completedAt: completedAt.toISOString()
    });

    const result = scoreEvaluationTurn(turn, goldenCase);
    expect(result.breakdown.latency).toBe(5);
  });

  it("gives zero latency score over 30s", () => {
    const goldenCase: GoldenEvalCase = {
      id: "latency-zero",
      prompt: "Test latency"
    };

    const createdAt = new Date();
    const completedAt = new Date(createdAt.getTime() + 35000); // 35s

    const turn = makeTurn({
      createdAt: createdAt.toISOString(),
      completedAt: completedAt.toISOString()
    });

    const result = scoreEvaluationTurn(turn, goldenCase);
    expect(result.breakdown.latency).toBe(0);
    expect(result.notes.some((n) => n.includes("Latency too high"))).toBe(true);
  });

  it("penalizes SQL missing LIMIT clause", () => {
    const goldenCase: GoldenEvalCase = {
      id: "limit-check",
      prompt: "Test limit",
      expectedSqlPatterns: ["SELECT"]
    };

    const turn = makeTurn({
      toolExecutions: [
        makeToolExec({
          tool: "warehouse.query",
          input: { sql: "SELECT * FROM users" }
        })
      ]
    });

    const result = scoreEvaluationTurn(turn, goldenCase);
    expect(result.breakdown.sqlSafety).toBe(10); // base 10 + pattern 5 - limit 5 = 10
    expect(result.notes.some((n) => n.includes("Missing LIMIT"))).toBe(true);
  });
});
