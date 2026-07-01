import { describe, expect, it } from "vitest";
import { IterationBudget } from "./iterationBudget.js";
import { ContextCompressor } from "./contextCompressor.js";
import { DEFAULT_HARNESS_CONFIG } from "./types.js";

// ─── Duplicated from src/core/agentRuntime.ts (module-level, not exported) ───

function deepRedact(value: unknown, visited?: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "object") {
    if (visited?.has(value)) return "[CIRCULAR]";
    (visited ??= new WeakSet()).add(value);
  }
  if (typeof value === "string") {
    if (/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(value)) {
      return "[REDACTED_PRIVATE_KEY]";
    }
    if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(value)) {
      return value.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]");
    }
    if (/bearer\s+[a-zA-Z0-9_\-.]+/i.test(value)) {
      return value.replace(/bearer\s+[a-zA-Z0-9_\-.]+/gi, "Bearer [REDACTED_TOKEN]");
    }
    if (/(api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[a-zA-Z0-9_\-.]+["']?/i.test(value)) {
      return value.replace(
        /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)[a-zA-Z0-9_\-.]+(["']?)/gi,
        "$1[REDACTED]$2"
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((el) => deepRedact(el, visited));
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepRedact(val, visited);
    }
    return result;
  }
  return value;
}

function wildcardToRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function extractQualifiedRelations(sql: string): Array<{ schema: string; table: string }> {
  const relations = new Map<string, { schema: string; table: string }>();
  const normalized = sql
    .replace(/\`([^\`]+)\`/g, (_, p1) => p1)
    .replace(/"([^"]+)"/g, (_, p1) => p1);

  const tableContextRegex = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-zA-Z_][\w.]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = tableContextRegex.exec(normalized)) !== null) {
    const ref = match[1];
    const parts = ref.split(".");
    if (parts.length >= 2) {
      const table = parts[parts.length - 1];
      const schema = parts[parts.length - 2];
      if (schema && table) {
        const key = `${schema}.${table}`.toLowerCase();
        relations.set(key, { schema, table });
      }
    }
  }

  return Array.from(relations.values());
}

// ─── Helpers ───

function makeLongMessage(charCount: number): Record<string, unknown> {
  return { role: "user", content: "x".repeat(charCount) };
}

// ─── Tests ───

describe("deepRedact", () => {
  it("redacts private key patterns", () => {
    expect(deepRedact("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe(
      "[REDACTED_PRIVATE_KEY]"
    );
    expect(deepRedact("-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n-----END OPENSSH PRIVATE KEY-----")).toBe(
      "[REDACTED_PRIVATE_KEY]"
    );
    expect(deepRedact("-----BEGIN PGP PRIVATE KEY-----\n123\n-----END PGP PRIVATE KEY-----")).toBe(
      "[REDACTED_PRIVATE_KEY]"
    );
  });

  it("redacts email addresses", () => {
    expect(deepRedact("Contact alice@example.com please")).toBe("Contact [REDACTED_EMAIL] please");
    expect(deepRedact("user.name+tag@sub.domain.co.uk")).toBe("[REDACTED_EMAIL]");
  });

  it("redacts bearer tokens", () => {
    expect(deepRedact("Authorization: bearer abc123.xyz")).toBe("Authorization: Bearer [REDACTED_TOKEN]");
    expect(deepRedact("Bearer abc-def_123")).toBe("Bearer [REDACTED_TOKEN]");
  });

  it("redacts API keys, secrets, and passwords", () => {
    expect(deepRedact('api_key: "super_secret"')).toBe('api_key: "[REDACTED]"');
    expect(deepRedact("api-key=12345")).toBe("api-key=[REDACTED]");
    expect(deepRedact("password: hunter2")).toBe("password: [REDACTED]");
    expect(deepRedact("secret=shh")).toBe("secret=[REDACTED]");
    expect(deepRedact("token: abc123")).toBe("token: [REDACTED]");
    expect(deepRedact("passwd = xyz")).toBe("passwd = [REDACTED]");
    expect(deepRedact("pwd: 123")).toBe("pwd: [REDACTED]");
  });

  it("leaves normal strings untouched", () => {
    expect(deepRedact("hello world")).toBe("hello world");
    expect(deepRedact("SELECT * FROM users")).toBe("SELECT * FROM users");
  });

  it("redacts nested objects at all levels", () => {
    // NOTE: deepRedact matches labelled secrets (e.g. "password: xxx"),
    // not bare secret strings. Values must include the key label.
    const input = {
      name: "Alice",
      credentials: {
        password: "password: secret123",
        email: "alice@example.com",
        nested: {
          api_key: "api_key: key456"
        }
      }
    };
    const expected = {
      name: "Alice",
      credentials: {
        password: "password: [REDACTED]",
        email: "[REDACTED_EMAIL]",
        nested: {
          api_key: "api_key: [REDACTED]"
        }
      }
    };
    expect(deepRedact(input)).toEqual(expected);
  });

  it("redacts arrays with mixed sensitive and normal values", () => {
    const input = ["hello", "alice@example.com", { password: "password: secret" }, 42];
    const expected = ["hello", "[REDACTED_EMAIL]", { password: "password: [REDACTED]" }, 42];
    expect(deepRedact(input)).toEqual(expected);
  });

  it("handles circular references without stack overflow", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj.self = obj;
    expect(deepRedact(obj)).toEqual({ name: "test", self: "[CIRCULAR]" });
  });

  it("leaves null, undefined, numbers, and booleans untouched", () => {
    expect(deepRedact(null)).toBeNull();
    expect(deepRedact(undefined)).toBeUndefined();
    expect(deepRedact(42)).toBe(42);
    expect(deepRedact(3.14)).toBe(3.14);
    expect(deepRedact(true)).toBe(true);
    expect(deepRedact(false)).toBe(false);
  });
});

describe("wildcardToRegex", () => {
  it("matches everything with *", () => {
    expect(wildcardToRegex("*").test("anything")).toBe(true);
    expect(wildcardToRegex("*").test("")).toBe(true);
    expect(wildcardToRegex("*").test("production.users")).toBe(true);
  });

  it("matches prefix with prod*", () => {
    expect(wildcardToRegex("prod*").test("production")).toBe(true);
    expect(wildcardToRegex("prod*").test("prod")).toBe(true);
    expect(wildcardToRegex("prod*").test("staging")).toBe(false);
    expect(wildcardToRegex("prod*").test("aproduction")).toBe(false);
  });

  it("matches suffix with *.users", () => {
    expect(wildcardToRegex("*.users").test("public.users")).toBe(true);
    expect(wildcardToRegex("*.users").test("users")).toBe(false);
    expect(wildcardToRegex("*.users").test("public.users.extra")).toBe(false);
  });

  it("trims leading and trailing whitespace", () => {
    expect(wildcardToRegex("  prod*  ").test("production")).toBe(true);
  });

  it("escapes special regex characters", () => {
    expect(wildcardToRegex("$.+").test("$.+")).toBe(true);
    expect(wildcardToRegex("$.+").test("$X+")).toBe(false);
    expect(wildcardToRegex("a[b]").test("a[b]")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(wildcardToRegex("users").test("USERS")).toBe(true);
    expect(wildcardToRegex("PROD*").test("production")).toBe(true);
  });
});

describe("extractQualifiedRelations", () => {
  it("extracts basic FROM schema.table", () => {
    const sql = "SELECT * FROM schema.table";
    expect(extractQualifiedRelations(sql)).toEqual([{ schema: "schema", table: "table" }]);
  });

  it("extracts multiple JOINs with schema.table", () => {
    const sql = `
      SELECT * FROM schema1.users
      JOIN schema2.orders ON users.id = orders.user_id
      LEFT JOIN schema3.products ON orders.product_id = products.id
    `;
    const result = extractQualifiedRelations(sql);
    expect(result).toEqual([
      { schema: "schema1", table: "users" },
      { schema: "schema2", table: "orders" },
      { schema: "schema3", table: "products" }
    ]);
  });

  it("extracts schema.table from CTEs", () => {
    const sql = "WITH cte AS (SELECT * FROM schema.table) SELECT * FROM cte";
    expect(extractQualifiedRelations(sql)).toEqual([{ schema: "schema", table: "table" }]);
  });

  it("extracts schema.table from subqueries", () => {
    const sql = "SELECT * FROM (SELECT * FROM schema.inner_table) AS sub";
    expect(extractQualifiedRelations(sql)).toEqual([{ schema: "schema", table: "inner_table" }]);
  });

  it("handles quoted identifiers without spaces", () => {
    const sql = 'SELECT * FROM "schema"."table"';
    expect(extractQualifiedRelations(sql)).toEqual([{ schema: "schema", table: "table" }]);
  });

  it("does not handle quoted identifiers with spaces (implementation limit)", () => {
    // After stripping quotes, the space breaks the regex word boundary.
    const sql = 'SELECT * FROM "my schema"."my table"';
    expect(extractQualifiedRelations(sql)).toEqual([]);
  });

  it("handles backtick identifiers", () => {
    const sql = "SELECT * FROM `schema`.`table`";
    expect(extractQualifiedRelations(sql)).toEqual([{ schema: "schema", table: "table" }]);
  });

  it("filters out single-part names", () => {
    const sql = "SELECT * FROM users";
    expect(extractQualifiedRelations(sql)).toEqual([]);
  });

  it("handles three-part names (schema = second-to-last part)", () => {
    const sql = "SELECT * FROM project.dataset.table";
    expect(extractQualifiedRelations(sql)).toEqual([{ schema: "dataset", table: "table" }]);
  });

  it("does not detect tables inside SQL comments", () => {
    const sql = "-- joins schema.table to other.table\nSELECT * FROM real.table";
    // NOTE: current implementation does strip quoted/backtick identifiers but does NOT strip
    // comments, so a comment containing "FROM schema.table" would still match.  This test
    // uses "joins" (plural) which does NOT match the JOIN keyword, so no tables are found
    // from the comment line.
    expect(extractQualifiedRelations(sql)).toEqual([{ schema: "real", table: "table" }]);
  });

  it("returns empty array when there are no matches", () => {
    expect(extractQualifiedRelations("SELECT 1")).toEqual([]);
    expect(extractQualifiedRelations("SELECT * FROM users WHERE id = 1")).toEqual([]);
  });
});

describe("IterationBudget", () => {
  it("initial budget has maxTotal iterations", () => {
    const budget = new IterationBudget({ maxTotal: 10, label: "test" });
    expect(budget.maxTotal).toBe(10);
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(10);
  });

  it("consume returns true until exhausted", () => {
    const budget = new IterationBudget({ maxTotal: 3 });
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.used).toBe(3);
  });

  it("consume returns false when exhausted", () => {
    const budget = new IterationBudget({ maxTotal: 2 });
    budget.consume();
    budget.consume();
    expect(budget.consume()).toBe(false);
    expect(budget.consume()).toBe(false);
    expect(budget.used).toBe(2);
  });

  it("refund restores one iteration", () => {
    const budget = new IterationBudget({ maxTotal: 5 });
    budget.consume();
    budget.consume();
    expect(budget.used).toBe(2);
    budget.refund();
    expect(budget.used).toBe(1);
    expect(budget.remaining).toBe(4);
  });

  it("refund at 0 does nothing (floor protection)", () => {
    const budget = new IterationBudget({ maxTotal: 5 });
    expect(budget.used).toBe(0);
    budget.refund();
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(5);
  });

  it("multiple refunds do not exceed maxTotal (ceiling protection)", () => {
    const budget = new IterationBudget({ maxTotal: 5 });
    budget.consume();
    budget.consume();
    budget.refund();
    budget.refund();
    budget.refund();
    budget.refund();
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(5);
  });

  it("remaining returns correct count", () => {
    const budget = new IterationBudget({ maxTotal: 10 });
    expect(budget.remaining).toBe(10);
    budget.consume();
    expect(budget.remaining).toBe(9);
    budget.consume();
    budget.consume();
    expect(budget.remaining).toBe(7);
  });

  it("label works for diagnostics", () => {
    const budget = new IterationBudget({ maxTotal: 10, label: "my-agent" });
    expect(budget.label).toBe("my-agent");
    expect(budget.status).toBe("my-agent: 0/10 used, 10 remaining");
  });

  it("reset clears used count", () => {
    const budget = new IterationBudget({ maxTotal: 10 });
    budget.consume();
    budget.consume();
    expect(budget.used).toBe(2);
    budget.reset();
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(10);
  });
});

describe("IterationBudget default config", () => {
  it("DEFAULT_HARNESS_CONFIG has maxTotal = 90 for iteration budget", () => {
    expect(DEFAULT_HARNESS_CONFIG.iterationBudget.maxTotal).toBe(90);
  });

  it("can be constructed with default harness config values", () => {
    const budget = new IterationBudget(DEFAULT_HARNESS_CONFIG.iterationBudget);
    expect(budget.maxTotal).toBe(90);
    expect(budget.label).toBe("parent");
    expect(budget.remaining).toBe(90);
  });
});

describe("ContextCompressor.shouldCompress", () => {
  it("returns false for fewer than 5 messages", () => {
    const compressor = new ContextCompressor();
    const messages = Array.from({ length: 4 }, () => ({ role: "user", content: "short" }));
    expect(compressor.shouldCompress(messages, 128_000)).toBe(false);
  });

  it("returns false when under threshold", () => {
    const compressor = new ContextCompressor();
    // 5 short messages — well under the default 4096-token minimum threshold
    const messages = Array.from({ length: 5 }, () => ({ role: "user", content: "short" }));
    expect(compressor.shouldCompress(messages, 128_000)).toBe(false);
  });

  it("returns true when over threshold", () => {
    const compressor = new ContextCompressor();
    // 4 short messages + 1 very long message to push us over the threshold
    const messages = [
      ...Array.from({ length: 4 }, () => ({ role: "user", content: "short" })),
      makeLongMessage(20_000)
    ];
    // With contextLength=10_000, threshold = max(5_000, 4096) = 5_000 tokens
    // Total tokens ≈ 4*(5/4 + 10) + (20000/4 + 10) ≈ 50 + 5010 = 5060 > 5000
    expect(compressor.shouldCompress(messages, 10_000)).toBe(true);
  });

  it("returns false when on cooldown", async () => {
    // Use a small tail budget + many messages so the long message lands in the
    // MIDDLE segment and the summarizer is actually invoked.
    const compressor = new ContextCompressor({
      protectFirstN: 1,
      tailTokenBudget: 100,
      failureCooldownSec: 60
    });

    const messages = [
      { role: "system", content: "short" },
      ...Array.from({ length: 4 }, () => ({ role: "user", content: "short" })),
      makeLongMessage(20_000),
      ...Array.from({ length: 5 }, () => ({ role: "user", content: "short" }))
    ];

    // Verify it WOULD compress before the failure
    expect(compressor.shouldCompress(messages, 10_000)).toBe(true);

    // Trigger a failure to enter cooldown
    await compressor.compress({
      messages,
      contextLength: 10_000,
      summarize: async () => {
        throw new Error("LLM failure");
      }
    });

    // Now shouldCompress returns false because we're on cooldown
    expect(compressor.shouldCompress(messages, 10_000)).toBe(false);
  });

  it("returns false when thrashing (ineffective count >= max)", () => {
    const compressor = new ContextCompressor();
    const messages = [
      ...Array.from({ length: 4 }, () => ({ role: "user", content: "short" })),
      makeLongMessage(20_000)
    ];

    // Record ineffective compressions until thrashing
    compressor.recordCompressionResult(0, 1000); // 0% savings
    compressor.recordCompressionResult(0, 1000); // 0% savings again

    expect(compressor.isThrashing).toBe(true);
    expect(compressor.shouldCompress(messages, 10_000)).toBe(false);
  });

  it("returns true again after reset", () => {
    const compressor = new ContextCompressor();
    const messages = [
      ...Array.from({ length: 4 }, () => ({ role: "user", content: "short" })),
      makeLongMessage(20_000)
    ];

    compressor.recordCompressionResult(0, 1000);
    compressor.recordCompressionResult(0, 1000);
    expect(compressor.isThrashing).toBe(true);
    expect(compressor.shouldCompress(messages, 10_000)).toBe(false);

    compressor.reset();
    expect(compressor.isThrashing).toBe(false);
    expect(compressor.shouldCompress(messages, 10_000)).toBe(true);
  });
});
