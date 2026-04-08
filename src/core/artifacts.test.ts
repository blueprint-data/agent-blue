import { describe, expect, it } from "vitest";
import { getChartConfigFromArtifacts, getCsvFileArtifacts } from "./artifacts.js";

describe("artifact helpers", () => {
  it("returns only csv file artifacts for delivery", () => {
    const artifacts = [
      {
        type: "chartjs_config" as const,
        format: "json" as const,
        payload: { type: "bar" }
      },
      {
        type: "file" as const,
        format: "csv" as const,
        payload: {
          filePath: "/tmp/test.csv",
          fileName: "test.csv",
          columns: ["id"],
          rowCount: 1,
          bytes: 8,
          mimeType: "text/csv" as const
        }
      }
    ];

    expect(getChartConfigFromArtifacts(artifacts)).toEqual({ type: "bar" });
    expect(getCsvFileArtifacts(artifacts)).toEqual([artifacts[1]]);
  });
});
