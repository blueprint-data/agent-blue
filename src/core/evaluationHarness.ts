export interface GoldenEvalCase {
  id: string;
  prompt: string;
  expectedSqlPatterns?: string[];
  forbiddenSqlPatterns?: string[];
  requiredTools?: string[];
  forbiddenTools?: string[];
  requireAnswer?: boolean;
}

export interface EvalTurnBreakdown {
  planner: number;
  tools: number;
  sqlSafety: number;
  correctnessSignals: number;
  latency: number;
}

export interface EvalTurnSummary {
  caseId: string;
  prompt: string;
  score: number;
  breakdown: EvalTurnBreakdown;
  fallback: boolean;
  matchedExpectedSqlPatterns: string[];
  violatedForbiddenSqlPatterns: string[];
  missingRequiredTools: string[];
  violatedForbiddenTools: string[];
  notes: string[];
}

export const defaultGoldenEvalCases: GoldenEvalCase[] = [
  {
    id: "users_total",
    prompt: "How many users do we have in total?",
    requiredTools: ["warehouse.query"],
    requireAnswer: true
  },
  {
    id: "users_last_month",
    prompt: "How many were created last month?",
    requiredTools: ["warehouse.query"],
    expectedSqlPatterns: ["created", "month"],
    requireAnswer: true
  },
  {
    id: "transactions_since",
    prompt: "From those, how many made a transaction since?",
    requiredTools: ["warehouse.query"],
    expectedSqlPatterns: ["transaction"],
    requireAnswer: true
  },
  {
    id: "signup_chart",
    prompt: "Can you provide a bar chart by signup month for the last 6 months and summarize the trend?",
    requiredTools: ["warehouse.query", "chartjs.build"],
    expectedSqlPatterns: ["month", "signup"],
    requireAnswer: true
  }
];

function includesPattern(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function scoreEvaluationTurn(input: {
  prompt: string;
  text: string;
  debug?: Record<string, unknown>;
  goldenCase: GoldenEvalCase;
}): EvalTurnSummary {
  const toolCalls = Array.isArray(input.debug?.toolCalls)
    ? (input.debug?.toolCalls as Array<{ tool?: unknown; status?: unknown; error?: unknown }>)
    : [];
  const tools = toolCalls
    .map((call) => (typeof call.tool === "string" ? call.tool : ""))
    .filter((tool) => tool.length > 0);
  const sql = typeof input.debug?.sql === "string" ? input.debug.sql : "";
  const timings = (input.debug?.timings ?? {}) as Record<string, unknown>;
  const totalMs = typeof timings.totalMs === "number" ? timings.totalMs : null;
  const fallback = input.text.includes("I could not reach a reliable final answer");

  const matchedExpectedSqlPatterns = (input.goldenCase.expectedSqlPatterns ?? []).filter((pattern) =>
    includesPattern(sql, pattern)
  );
  const violatedForbiddenSqlPatterns = (input.goldenCase.forbiddenSqlPatterns ?? []).filter((pattern) =>
    includesPattern(sql, pattern)
  );
  const missingRequiredTools = (input.goldenCase.requiredTools ?? []).filter((tool) => !tools.includes(tool));
  const violatedForbiddenTools = (input.goldenCase.forbiddenTools ?? []).filter((tool) => tools.includes(tool));

  let planner = 20;
  const plannerAttempts = Array.isArray(input.debug?.plannerAttempts) ? input.debug?.plannerAttempts.length : 0;
  if (plannerAttempts === 0) planner -= 10;
  if (plannerAttempts > 6) planner -= Math.min(10, plannerAttempts - 6);
  if (fallback) planner -= 10;

  let toolScore = 25;
  toolScore -= missingRequiredTools.length * 10;
  toolScore -= violatedForbiddenTools.length * 10;
  const toolErrors = toolCalls.filter((call) => call.status === "error").length;
  toolScore -= Math.min(10, toolErrors * 3);

  let sqlSafety = 25;
  if (sql.length === 0 && (input.goldenCase.expectedSqlPatterns?.length ?? 0) > 0) {
    sqlSafety -= 15;
  }
  sqlSafety -= violatedForbiddenSqlPatterns.length * 10;
  if (sql && !includesPattern(sql, "limit")) {
    sqlSafety -= 5;
  }

  let correctnessSignals = 20;
  if (input.goldenCase.requireAnswer && input.text.trim().length === 0) {
    correctnessSignals -= 15;
  }
  if ((input.goldenCase.expectedSqlPatterns?.length ?? 0) > 0 && matchedExpectedSqlPatterns.length === 0) {
    correctnessSignals -= 10;
  }
  if (fallback) {
    correctnessSignals -= 5;
  }

  let latency = 10;
  if (typeof totalMs === "number") {
    if (totalMs > 30_000) latency = 0;
    else if (totalMs > 15_000) latency = 4;
    else if (totalMs > 8_000) latency = 7;
  }

  const breakdown: EvalTurnBreakdown = {
    planner: Math.max(0, planner),
    tools: Math.max(0, toolScore),
    sqlSafety: Math.max(0, sqlSafety),
    correctnessSignals: Math.max(0, correctnessSignals),
    latency: Math.max(0, latency)
  };

  const notes: string[] = [];
  if (fallback) notes.push("Turn fell back to the generic reliability fallback.");
  if (missingRequiredTools.length > 0) notes.push(`Missing required tools: ${missingRequiredTools.join(", ")}`);
  if (violatedForbiddenTools.length > 0) notes.push(`Used forbidden tools: ${violatedForbiddenTools.join(", ")}`);
  if (violatedForbiddenSqlPatterns.length > 0) {
    notes.push(`SQL matched forbidden patterns: ${violatedForbiddenSqlPatterns.join(", ")}`);
  }

  return {
    caseId: input.goldenCase.id,
    prompt: input.prompt,
    score: breakdown.planner + breakdown.tools + breakdown.sqlSafety + breakdown.correctnessSignals + breakdown.latency,
    breakdown,
    fallback,
    matchedExpectedSqlPatterns,
    violatedForbiddenSqlPatterns,
    missingRequiredTools,
    violatedForbiddenTools,
    notes
  };
}
