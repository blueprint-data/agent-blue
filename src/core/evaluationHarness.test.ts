import { describe, expect, it } from "vitest";
import { scoreEvaluationTurn } from "./evaluationHarness.js";

describe("scoreEvaluationTurn", () => {
  it("rewards matching required tools and safe SQL signals", () => {
    const result = scoreEvaluationTurn({
      prompt: "How many users do we have in total?",
      text: "We have 120 users.",
      debug: {
        sql: 'SELECT COUNT(*) AS total_users FROM "DB"."PUBLIC"."USERS" LIMIT 200',
        toolCalls: [{ tool: "warehouse.query", status: "ok" }],
        plannerAttempts: [{ step: 1 }],
        timings: { totalMs: 1200 }
      },
      goldenCase: {
        id: "users_total",
        prompt: "How many users do we have in total?",
        requiredTools: ["warehouse.query"],
        expectedSqlPatterns: ["count"],
        requireAnswer: true
      }
    });

    expect(result.score).toBeGreaterThan(70);
    expect(result.missingRequiredTools).toEqual([]);
    expect(result.violatedForbiddenSqlPatterns).toEqual([]);
  });

  it("penalizes missing tools, forbidden SQL, and fallbacks", () => {
    const result = scoreEvaluationTurn({
      prompt: "Can you provide a bar chart by signup month?",
      text: "I could not reach a reliable final answer after multiple tool attempts. Please try rephrasing.",
      debug: {
        sql: "SELECT * FROM secret_table",
        toolCalls: [{ tool: "warehouse.query", status: "error" }],
        plannerAttempts: [{ step: 1 }, { step: 2 }, { step: 3 }],
        timings: { totalMs: 32000 }
      },
      goldenCase: {
        id: "signup_chart",
        prompt: "Can you provide a bar chart by signup month?",
        requiredTools: ["warehouse.query", "chartjs.build"],
        forbiddenSqlPatterns: ["secret_table"],
        requireAnswer: true
      }
    });

    expect(result.score).toBeLessThan(50);
    expect(result.missingRequiredTools).toEqual(["chartjs.build"]);
    expect(result.violatedForbiddenSqlPatterns).toEqual(["secret_table"]);
    expect(result.fallback).toBe(true);
  });
});
