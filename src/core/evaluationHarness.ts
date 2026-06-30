import type {
  AgentExecutionTurn,
  EvalTurnBreakdown,
  EvalTurnSummary,
  ExecutionTraceEvent,
  GoldenEvalCase,
  ToolExecutionRecord
} from "./types.js";

export const DEFAULT_GOLDEN_EVAL_CASES: GoldenEvalCase[] = [
  {
    id: "basic-count",
    prompt: "How many users signed up last month?",
    expectedSqlPatterns: ["COUNT(", "created_at"],
    forbiddenSqlPatterns: ["DROP", "DELETE", "UPDATE", "INSERT"],
    requiredTools: ["dbt.listModels", "warehouse.query"],
    forbiddenTools: ["tenantMemory.save"],
    requireAnswer: true
  },
  {
    id: "revenue-by-region",
    prompt: "What was revenue by region this quarter?",
    expectedSqlPatterns: ["SUM(", "GROUP BY", "region"],
    forbiddenSqlPatterns: ["DROP", "DELETE", "UPDATE", "INSERT"],
    requiredTools: ["dbt.listModels", "warehouse.query"],
    requireAnswer: true
  },
  {
    id: "top-customers",
    prompt: "Top 10 customers by revenue",
    expectedSqlPatterns: ["ORDER BY", "DESC", "LIMIT"],
    forbiddenSqlPatterns: ["DELETE", "UPDATE", "DROP"],
    requiredTools: ["warehouse.query"],
    requireAnswer: true
  },
  {
    id: "cohort-analysis",
    prompt: "Show me a cohort retention analysis for the last 6 months",
    expectedSqlPatterns: ["DATE_TRUNC", "cohort", "retention"],
    forbiddenSqlPatterns: ["DELETE", "UPDATE", "DROP"],
    requiredTools: ["dbt.listModels", "warehouse.query"],
    requireAnswer: true
  },
  {
    id: "month-over-month",
    prompt: "Month over month growth rate",
    expectedSqlPatterns: ["LAG(", "LEAD(", "growth", "month"],
    forbiddenSqlPatterns: ["DELETE", "UPDATE", "DROP"],
    requiredTools: ["warehouse.query"],
    requireAnswer: true
  }
];

function extractSqls(toolExecutions: ToolExecutionRecord[] | undefined): string[] {
  if (!toolExecutions) return [];
  return toolExecutions
    .filter((te) => te.tool === "warehouse.query" && typeof te.input?.sql === "string")
    .map((te) => te.input.sql as string);
}

function isFallback(turn: AgentExecutionTurn): boolean {
  if (turn.status === "failed") return true;
  if (turn.errorMessage && turn.errorMessage.trim().length > 0) return true;
  if (!turn.assistantText || turn.assistantText.trim().length === 0) return true;
  const text = turn.assistantText.toLowerCase();
  if (text.includes("could not reach")) return true;
  if (text.includes("cannot_answer")) return true;
  if (text.includes("i don't know")) return true;
  if (text.includes("unable to answer")) return true;
  if (turn.debug?.outcome === "cannot_answer") return true;
  return false;
}

export function scoreEvaluationTurn(
  turn: AgentExecutionTurn,
  goldenCase: GoldenEvalCase
): EvalTurnSummary {
  const events = turn.events ?? [];
  const toolExecutions = turn.toolExecutions ?? [];
  const fallback = isFallback(turn);

  const notes: string[] = [];

  // ── Planner (max 20) ──────────────────────────────────────────────
  const plannerAttempts = events.filter((e) => e.type === "planner.decision").length;
  let planner = 0;
  if (plannerAttempts > 0) {
    planner = Math.min(plannerAttempts * 5, 20);
  }
  if (plannerAttempts > 6) {
    planner = Math.max(planner - 8, 0);
    notes.push(`Too many planner attempts (${plannerAttempts})`);
  }
  if (fallback) {
    planner = Math.max(planner - 10, 0);
  }

  // ── Tools (max 25) ────────────────────────────────────────────────
  let tools = 0;
  if (toolExecutions.length > 0) {
    tools += 10;
  }
  const missingRequiredTools: string[] = [];
  if (goldenCase.requiredTools) {
    for (const required of goldenCase.requiredTools) {
      const found = toolExecutions.some((te) => te.tool === required);
      if (found) {
        tools += 5;
      } else {
        missingRequiredTools.push(required);
      }
    }
  }
  const violatedForbiddenTools: string[] = [];
  if (goldenCase.forbiddenTools) {
    for (const forbidden of goldenCase.forbiddenTools) {
      const found = toolExecutions.some((te) => te.tool === forbidden);
      if (found) {
        tools -= 10;
        violatedForbiddenTools.push(forbidden);
      }
    }
  }
  const errorCount = toolExecutions.filter((te) => te.status === "error").length;
  if (errorCount > 0) {
    tools -= errorCount * 5;
    notes.push(`${errorCount} tool execution(s) failed`);
  }
  tools = Math.max(0, Math.min(25, tools));

  // ── SQL Safety (max 25) ───────────────────────────────────────────
  const sqls = extractSqls(toolExecutions);
  let sqlSafety = 0;
  const matchedExpectedSqlPatterns: string[] = [];
  const violatedForbiddenSqlPatterns: string[] = [];

  if (sqls.length > 0) {
    sqlSafety += 10;

    if (goldenCase.expectedSqlPatterns) {
      for (const pattern of goldenCase.expectedSqlPatterns) {
        if (sqls.some((sql) => sql.toLowerCase().includes(pattern.toLowerCase()))) {
          sqlSafety += 5;
          matchedExpectedSqlPatterns.push(pattern);
        }
      }
    }

    if (goldenCase.forbiddenSqlPatterns) {
      for (const pattern of goldenCase.forbiddenSqlPatterns) {
        if (sqls.some((sql) => sql.toLowerCase().includes(pattern.toLowerCase()))) {
          sqlSafety -= 10;
          violatedForbiddenSqlPatterns.push(pattern);
        }
      }
    }

    const hasLimit = sqls.some((sql) => /\blimit\s+\d+/i.test(sql));
    if (!hasLimit) {
      sqlSafety -= 5;
      notes.push("Missing LIMIT clause in SQL");
    }
  } else {
    notes.push("No warehouse.query SQL found");
  }

  sqlSafety = Math.max(0, Math.min(25, sqlSafety));

  // ── Correctness Signals (max 20) ──────────────────────────────────
  let correctnessSignals = 0;
  if (turn.assistantText && turn.assistantText.trim().length > 0) {
    correctnessSignals += 10;
    if (goldenCase.requireAnswer) {
      correctnessSignals += 10;
    }
  } else if (goldenCase.requireAnswer) {
    notes.push("Missing required answer");
  }
  correctnessSignals = Math.min(20, correctnessSignals);

  // ── Latency (max 10) ──────────────────────────────────────────────
  let latency = 0;
  if (turn.createdAt && turn.completedAt) {
    const durationMs =
      new Date(turn.completedAt).getTime() - new Date(turn.createdAt).getTime();
    const durationSec = durationMs / 1000;
    if (durationSec <= 8) {
      latency = 10;
    } else if (durationSec <= 15) {
      latency = 5;
    } else if (durationSec <= 30) {
      latency = 2;
    } else {
      latency = 0;
      notes.push(`Latency too high (${durationSec.toFixed(1)}s)`);
    }
  } else {
    notes.push("Missing timing data for latency calculation");
  }

  const breakdown: EvalTurnBreakdown = {
    planner,
    tools,
    sqlSafety,
    correctnessSignals,
    latency
  };

  const score = planner + tools + sqlSafety + correctnessSignals + latency;

  return {
    caseId: goldenCase.id,
    prompt: goldenCase.prompt,
    score,
    breakdown,
    fallback,
    matchedExpectedSqlPatterns,
    violatedForbiddenSqlPatterns,
    missingRequiredTools,
    violatedForbiddenTools,
    notes
  };
}
