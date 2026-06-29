export interface MetadataCacheEntry {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
  ts: number;
}

export class MetadataCache {
  private cache = new Map<string, MetadataCacheEntry>();

  constructor(private ttlMs: number = 1_800_000) {}

  key(tenantId: string, sql: string): string {
    let hash = 0;
    for (let i = 0; i < sql.length; i++) {
      const char = sql.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return `${tenantId}:${hash}`;
  }

  get(cacheKey: string): MetadataCacheEntry | undefined {
    const entry = this.cache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(cacheKey);
      return undefined;
    }
    return entry;
  }

  set(cacheKey: string, entry: Omit<MetadataCacheEntry, "ts">): void {
    this.cache.set(cacheKey, { ...entry, ts: Date.now() });
  }

  invalidateTenant(tenantId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}