import { describe, expect, it } from "vitest";
import { positiveIntEnv } from "./env.js";

describe("positiveIntEnv", () => {
  it("parses a valid positive integer", () => {
    expect(positiveIntEnv("60000", 300000)).toBe(60000);
  });

  it("falls back when the value is undefined", () => {
    expect(positiveIntEnv(undefined, 300000)).toBe(300000);
  });

  it("falls back when the value is non-numeric (prevents NaN TTL that never expires)", () => {
    expect(positiveIntEnv("not-a-number", 300000)).toBe(300000);
  });

  it("falls back when the value is zero or negative", () => {
    expect(positiveIntEnv("0", 300000)).toBe(300000);
    expect(positiveIntEnv("-5", 300000)).toBe(300000);
  });

  it("falls back on empty string", () => {
    expect(positiveIntEnv("", 300000)).toBe(300000);
  });

  it("parses leading-numeric strings the same way parseInt does", () => {
    expect(positiveIntEnv("1500ms", 300000)).toBe(1500);
  });
});
