export interface SqlGuardOptions {
  enforceReadOnly?: boolean;
  defaultLimit?: number;
  maxLimit?: number;
}

const WRITE_KEYWORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|call)\b/i;
const SELECT_KEYWORDS = /^\s*(with\b[\s\S]+?\bselect\b|select\b)/i;
const LIMIT_REGEX = /\blimit\s+(\d+)\b/i;

export class SqlGuard {
  private readonly enforceReadOnly: boolean;
  private readonly defaultLimit: number;
  private readonly maxLimit: number;

  constructor(options: SqlGuardOptions = {}) {
    this.enforceReadOnly = options.enforceReadOnly ?? true;
    this.defaultLimit = options.defaultLimit ?? 200;
    this.maxLimit = options.maxLimit ?? 2000;
  }

  private assertReadOnly(trimmed: string): void {
    if (!this.enforceReadOnly) {
      return;
    }
    if (!SELECT_KEYWORDS.test(trimmed)) {
      throw new Error("Only SELECT/WITH queries are allowed.");
    }
    if (WRITE_KEYWORDS.test(trimmed)) {
      throw new Error("Write/query-modifying SQL is not allowed.");
    }
  }

  normalizeForExport(sql: string): string {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    if (!trimmed) {
      throw new Error("SQL is empty.");
    }
    this.assertReadOnly(trimmed);
    return trimmed;
  }

  normalize(sql: string): string {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    if (!trimmed) {
      throw new Error("SQL is empty.");
    }
    this.assertReadOnly(trimmed);

    const limitMatch = trimmed.match(LIMIT_REGEX);
    if (!limitMatch) {
      return `${trimmed}\nLIMIT ${this.defaultLimit}`;
    }

    const requested = Number.parseInt(limitMatch[1] ?? "0", 10);
    if (Number.isNaN(requested) || requested <= 0) {
      throw new Error("Invalid LIMIT clause.");
    }
    if (requested > this.maxLimit) {
      return trimmed.replace(LIMIT_REGEX, `LIMIT ${this.maxLimit}`);
    }
    return trimmed;
  }
}
