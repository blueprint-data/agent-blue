import { describe, expect, it } from "vitest";
import { SqlGuard } from "./sqlGuard.js";

describe("SqlGuard export normalization", () => {
  it("keeps read-only export SQL untouched when no limit is present", () => {
    const guard = new SqlGuard({
      enforceReadOnly: true,
      defaultLimit: 200,
      maxLimit: 2000
    });

    expect(guard.normalizeForExport("select * from analytics.fact_orders")).toBe(
      "select * from analytics.fact_orders"
    );
  });

  it("rejects non-read-only export SQL", () => {
    const guard = new SqlGuard({
      enforceReadOnly: true,
      defaultLimit: 200,
      maxLimit: 2000
    });

    expect(() => guard.normalizeForExport("delete from analytics.fact_orders")).toThrow(
      "Only SELECT/WITH queries are allowed."
    );
  });
});
