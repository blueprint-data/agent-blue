import { AgentArtifact, FileArtifact } from "./types.js";

export function getChartConfigFromArtifacts(artifacts: AgentArtifact[] | undefined): Record<string, unknown> | null {
  for (const artifact of artifacts ?? []) {
    if (artifact.type === "chartjs_config" && artifact.format === "json") {
      return artifact.payload;
    }
  }
  return null;
}

export function getCsvFileArtifacts(artifacts: AgentArtifact[] | undefined): FileArtifact[] {
  return (artifacts ?? []).filter(
    (artifact): artifact is FileArtifact => artifact.type === "file" && artifact.format === "csv"
  );
}
