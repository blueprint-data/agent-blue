/**
 * Harness facade — re-exports all Harness v3 components and provides
 * backward-compatible convenience functions.
 *
 * New code should import directly from:
 *   - src/core/harness/contextCompressor.ts
 *   - src/core/harness/iterationBudget.ts
 *   - src/core/harness/memoryProvider.ts
 *   - src/core/harness/orchestrator.ts
 *   - src/core/harness/types.ts
 */

export { ContextCompressor } from "./harness/contextCompressor.js";
export type { CompressionResult, CompressorState, ContextCompressorConfig } from "./harness/types.js";
export { IterationBudget } from "./harness/iterationBudget.js";
export type { IterationBudgetConfig } from "./harness/types.js";
export { SqliteMemoryProvider, EngramMemoryProvider } from "./harness/memoryProvider.js";
export type { MemoryProvider } from "./harness/memoryProvider.js";
export type { TurnRecord, ToolSchema } from "./harness/types.js";
export { HarnessOrchestrator } from "./harness/orchestrator.js";
export type { HarnessConfig } from "./harness/types.js";
export { DEFAULT_COMPRESSOR_CONFIG, DEFAULT_HARNESS_CONFIG } from "./harness/types.js";

import { createId } from "../utils/id.js";
import type { ConversationStore } from "./interfaces.js";
import type { AnalyticSkill } from "./types.js";

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "ought",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "and", "but", "or", "yet", "so", "if", "because",
  "although", "though", "while", "where", "when", "that", "which",
  "who", "whom", "whose", "what", "this", "these", "those", "i", "me",
  "my", "we", "our", "you", "your", "he", "him", "his", "she", "her",
  "it", "its", "they", "them", "their", "am", "having", "doing", "until",
  "up", "down", "out", "off", "over", "again", "further", "then", "once",
  "here", "there", "all", "any", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "than", "too", "very", "just", "now", "don", "ll", "m", "o", "re",
  "ve", "y", "aren", "couldn", "didn", "doesn", "hadn", "hasn", "haven",
  "isn", "ma", "mightn", "mustn", "needn", "shan", "shouldn", "wasn",
  "weren", "won", "wouldn"
]);

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  revenue: ["revenue", "sales", "gmv", "arr", "mrr", "transaction", "transactions"],
  cohort: ["cohort", "cohorts"],
  retention: ["retention", "retain", "churn", "stickiness", "returning"],
  funnel: ["funnel", "funnels", "conversion", "dropoff", "drop-off", "drop off"],
  growth: ["growth", "mau", "dau", "wau", "active users", "signup", "signups", "registrations"],
  engagement: ["engagement", "session", "sessions", "pageview", "pageviews", "events", "event"],
  ltv: ["ltv", "lifetime value", "clv"],
  cac: ["cac", "customer acquisition cost", "acquisition"],
  roi: ["roi", "return on investment", "roas"],
  segmentation: ["segment", "segments", "segmentation", "persona", "personas"],
  trend: ["trend", "trending", "time series", "timeseries", "month over month", "mom", "year over year", "yoy", "weekly", "monthly", "daily"],
  kpi: ["kpi", "kpis", "metric", "metrics", "dashboard", "benchmark"],
  forecast: ["forecast", "forecasting", "predict", "prediction", "project", "projection"],
  sql: ["sql", "query", "queries", "table", "tables", "column", "columns", "schema"]
};

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/\b[a-z0-9_]+\b/g);
  if (!matches) return [];
  return matches.filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

function inferCategory(userMessage: string, sql: string): string {
  const text = `${userMessage} ${sql}`.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      return category;
    }
  }
  return "general";
}

function computeComplexity(sql: string): number {
  const normalized = sql.toLowerCase();
  let score = 1;
  if (/\bjoin\b/.test(normalized)) score += 1;
  if (/\bwith\b/.test(normalized)) score += 1;
  if (/\bgroup\s+by\b/.test(normalized)) score += 1;
  if (/\bhaving\b/.test(normalized)) score += 1;
  if (/\bover\s*\(/.test(normalized)) score += 1;
  if (/\bunion\b/.test(normalized)) score += 1;
  if (/\(\s*select\b/.test(normalized)) score += 1;
  return Math.min(score, 10);
}

// ─── Self-Improving Analytics Skills ───────────────────────────

/**
 * Extracts and persists an analytic SQL pattern as a reusable skill.
 *
 * Skips persistence when feedback is "thumbsdown". When feedback is missing,
 * the caller is assumed to have validated success (e.g. successful
 * warehouse.query + assistant answer).
 */
export async function maybeSaveAnalyticPattern(
  store: ConversationStore,
  params: {
    userMessage: string;
    sql: string;
    warehouse: string;
    feedback?: "thumbsup" | "thumbsdown";
    turnDebug?: Record<string, unknown>;
  }
): Promise<void> {
  const { userMessage, sql, warehouse, feedback } = params;

  if (feedback === "thumbsdown") return;

  const trimmedSql = sql.trim();
  if (!trimmedSql) return;

  const category = inferCategory(userMessage, trimmedSql);
  const normalizedSql = trimmedSql.replace(/\s+/g, " ").toLowerCase();

  const existing = store.findAnalyticSkillBySql(normalizedSql);

  const tags = [...new Set([...tokenize(userMessage), ...tokenize(trimmedSql)])].slice(0, 12);
  const complexity = computeComplexity(trimmedSql);
  const now = new Date().toISOString();

  if (existing) {
    store.updateAnalyticSkill(existing.id, {
      successCount: existing.successCount + 1,
      lastUsedAt: now,
      tags: [...new Set([...existing.tags, ...tags])].slice(0, 12),
      warehouse
    });
  } else {
    store.saveAnalyticSkill({
      id: createId("skill"),
      category,
      description: userMessage.slice(0, 240),
      sql: trimmedSql,
      warehouse,
      tags,
      complexity,
      successCount: 1,
      createdAt: now,
      lastUsedAt: now
    });
  }
}

/**
 * Loads analytic skills whose tags / description overlap with the user's
 * query. Scored by token overlap, then by success count.
 */
export async function loadRelevantSkills(
  store: ConversationStore,
  userMessage: string,
  limit = 5
): Promise<AnalyticSkill[]> {
  return store.searchAnalyticSkills(userMessage, limit);
}

// ─── Context Files per Tenant ─────────────────────────────────

export async function loadTenantContext(
  store: ConversationStore,
  tenantId: string
): Promise<string | null> {
  return store.getTenantContext(tenantId);
}

export async function saveTenantContext(
  store: ConversationStore,
  tenantId: string,
  content: string
): Promise<void> {
  store.saveTenantContext(tenantId, content);
}

// ─── Session Resume ───────────────────────────────────────────

export async function getSessionResumeContext(
  store: ConversationStore,
  conversationId: string,
  tenantId: string
): Promise<string | null> {
  const session = store.getSessionResumeData(conversationId, tenantId);
  if (!session) return null;

  const lines = [
    "## Session Resume",
    "",
    `Previous conversation summary: ${session.summaryText}`,
    `Topics discussed: ${session.topics.join(", ")}`,
    `Total messages: ${session.messageCount}`,
    ""
  ];

  if (session.lastExchanges && session.lastExchanges.length > 0) {
    lines.push("Last exchanges:");
    for (const msg of session.lastExchanges) {
      const label = msg.role === "user" ? "User" : "Assistant";
      lines.push(`${label}: ${msg.content}`);
    }
  }

  return lines.join("\n");
}

export async function saveSessionSummary(
  store: ConversationStore,
  params: {
    conversationId: string;
    tenantId: string;
    messages: Array<{ role: string; content: string }>;
    topics: string[];
  }
): Promise<void> {
  const { conversationId, tenantId, messages, topics } = params;

  const lastExchanges = messages.slice(-4);
  const summaryText =
    topics.length > 0
      ? `Previous conversation covering ${topics.join(", ")}.`
      : `Previous conversation with ${messages.length} messages.`;

  store.saveSessionSummary({
    conversationId,
    tenantId,
    summaryText,
    topics,
    messageCount: messages.length,
    lastExchanges
  });
}
