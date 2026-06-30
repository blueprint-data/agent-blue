import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { createId } from "../utils/id.js";
import type { AnalyticSkill, SessionSummary } from "./types.js";

const DATA_DIR = env.appDataDir;
const SKILLS_DIR = path.join(DATA_DIR, "skills");
const TENANTS_DIR = path.join(DATA_DIR, "tenants");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

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

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

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
export async function maybeSaveAnalyticPattern(params: {
  userMessage: string;
  sql: string;
  warehouse: string;
  feedback?: "thumbsup" | "thumbsdown";
  turnDebug?: Record<string, unknown>;
}): Promise<void> {
  const { userMessage, sql, warehouse, feedback } = params;

  if (feedback === "thumbsdown") return;

  const trimmedSql = sql.trim();
  if (!trimmedSql) return;

  const category = inferCategory(userMessage, trimmedSql);
  const skillFile = path.join(SKILLS_DIR, `${category}.json`);

  await ensureDir(SKILLS_DIR);

  let skills: AnalyticSkill[] = [];
  try {
    const raw = await readFile(skillFile, "utf-8");
    skills = JSON.parse(raw) as AnalyticSkill[];
    if (!Array.isArray(skills)) skills = [];
  } catch {
    skills = [];
  }

  const normalizedSql = trimmedSql.replace(/\s+/g, " ").toLowerCase();
  const existing = skills.find(
    (s) => s.sql.replace(/\s+/g, " ").toLowerCase() === normalizedSql
  );

  const tags = [...new Set([...tokenize(userMessage), ...tokenize(trimmedSql)])].slice(0, 12);
  const complexity = computeComplexity(trimmedSql);
  const now = new Date().toISOString();

  if (existing) {
    existing.successCount += 1;
    existing.lastUsedAt = now;
    existing.tags = [...new Set([...existing.tags, ...tags])].slice(0, 12);
    existing.warehouse = warehouse;
  } else {
    skills.push({
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

  await writeFile(skillFile, JSON.stringify(skills, null, 2));
}

/**
 * Loads analytic skills whose tags / description overlap with the user's
 * query. Scored by token overlap, then by success count.
 */
export async function loadRelevantSkills(userMessage: string, limit = 5): Promise<AnalyticSkill[]> {
  let allSkills: AnalyticSkill[] = [];

  try {
    const files = await readdir(SKILLS_DIR);
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const raw = await readFile(path.join(SKILLS_DIR, file), "utf-8");
      const parsed = JSON.parse(raw) as AnalyticSkill[];
      if (Array.isArray(parsed)) {
        allSkills.push(...parsed);
      }
    }
  } catch {
    return [];
  }

  if (allSkills.length === 0) return [];

  const userTokens = new Set(tokenize(userMessage));

  const scored = allSkills.map((skill) => {
    const skillTokens = new Set([
      ...tokenize(skill.description),
      ...skill.tags,
      skill.category,
      ...tokenize(skill.sql)
    ]);
    let score = 0;
    for (const token of userTokens) {
      if (skillTokens.has(token)) score += 1;
    }
    return { skill, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.skill.successCount - a.skill.successCount;
  });

  return scored.slice(0, limit).map((s) => s.skill);
}

// ─── Context Files per Tenant ─────────────────────────────────

export async function loadTenantContext(tenantId: string): Promise<string | null> {
  const filePath = path.join(TENANTS_DIR, tenantId, "CONTEXT.md");
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function saveTenantContext(tenantId: string, content: string): Promise<void> {
  const dir = path.join(TENANTS_DIR, tenantId);
  await ensureDir(dir);
  await writeFile(path.join(dir, "CONTEXT.md"), content, "utf-8");
}

// ─── Session Resume ───────────────────────────────────────────

interface PersistedSession extends SessionSummary {
  lastExchanges: Array<{ role: string; content: string }>;
}

export async function getSessionResumeContext(conversationId: string, tenantId: string): Promise<string | null> {
  const filePath = path.join(SESSIONS_DIR, tenantId, `${conversationId}.json`);
  try {
    const raw = await readFile(filePath, "utf-8");
    const session = JSON.parse(raw) as PersistedSession;

    const lines = [
      "## Session Resume",
      "",
      `Previous conversation summary: ${session.summary}`,
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
  } catch {
    return null;
  }
}

export async function saveSessionSummary(params: {
  conversationId: string;
  tenantId: string;
  messages: Array<{ role: string; content: string }>;
  topics: string[];
}): Promise<void> {
  const { conversationId, tenantId, messages, topics } = params;
  const dir = path.join(SESSIONS_DIR, tenantId);
  await ensureDir(dir);

  const lastExchanges = messages.slice(-4);
  const summaryText =
    topics.length > 0
      ? `Previous conversation covering ${topics.join(", ")}.`
      : `Previous conversation with ${messages.length} messages.`;

  const session: PersistedSession = {
    conversationId,
    tenantId,
    lastMessageAt: new Date().toISOString(),
    messageCount: messages.length,
    topics,
    summary: summaryText,
    createdAt: new Date().toISOString(),
    lastExchanges
  };

  await writeFile(path.join(dir, `${conversationId}.json`), JSON.stringify(session, null, 2));
}
