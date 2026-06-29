import { describe, expect, it } from "vitest";
import { MetadataCache } from "./metadataCache.js";

const sampleEntry = {
  rows: [{ table_name: "fct_transactions" }],
  columns: ["table_name"],
  rowCount: 1
};

describe("MetadataCache", () => {
  it("stores and returns an entry within the TTL", () => {
    const cache = new MetadataCache();
    const key = cache.key("acme", "SELECT 1");
    cache.set(key, sampleEntry);

    const got = cache.get(key);
    expect(got?.rows).toEqual(sampleEntry.rows);
    expect(got?.columns).toEqual(sampleEntry.columns);
    expect(got?.rowCount).toBe(1);
    expect(typeof got?.ts).toBe("number");
  });

  it("returns undefined for an unknown key", () => {
    const cache = new MetadataCache();
    expect(cache.get(cache.key("acme", "SELECT 2"))).toBeUndefined();
  });

  it("produces distinct keys per tenant for the same SQL", () => {
    const cache = new MetadataCache();
    expect(cache.key("acme", "SELECT 1")).not.toBe(cache.key("globex", "SELECT 1"));
  });

  it("expires entries once past the TTL", () => {
    // ttl of -1 means any stored entry is already expired on read.
    const cache = new MetadataCache(-1);
    const key = cache.key("acme", "SELECT 1");
    cache.set(key, sampleEntry);
    expect(cache.get(key)).toBeUndefined();
  });

  it("invalidates only the targeted tenant", () => {
    const cache = new MetadataCache();
    const acmeKey = cache.key("acme", "SELECT 1");
    const globexKey = cache.key("globex", "SELECT 1");
    cache.set(acmeKey, sampleEntry);
    cache.set(globexKey, sampleEntry);

    cache.invalidateTenant("acme");

    expect(cache.get(acmeKey)).toBeUndefined();
    expect(cache.get(globexKey)).toBeDefined();
  });

  it("clears every entry", () => {
    const cache = new MetadataCache();
    const key = cache.key("acme", "SELECT 1");
    cache.set(key, sampleEntry);
    cache.clear();
    expect(cache.get(key)).toBeUndefined();
  });
});
