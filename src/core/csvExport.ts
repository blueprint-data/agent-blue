import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { CsvExportResult } from "./types.js";

function formatCsvScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export function escapeCsvValue(value: unknown): string {
  const text = formatCsvScalar(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

export function buildCsvLine(columns: string[], row: Record<string, unknown>): string {
  return `${columns.map((column) => escapeCsvValue(row[column])).join(",")}\n`;
}

export async function writeWritable(stream: Writable, chunk: string): Promise<void> {
  if (stream.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

export async function endWritable(stream: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("finish", onFinish);
      stream.off("error", onError);
    };
    stream.once("finish", onFinish);
    stream.once("error", onError);
    stream.end();
  });
}

export async function createTempCsvTarget(fileName?: string): Promise<{
  dirPath: string;
  filePath: string;
  fileName: string;
  cleanup: () => Promise<void>;
}> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "agent-blue-csv-"));
  const safeBaseName = (fileName?.trim() || `export-${Date.now()}.csv`).replace(/[^a-zA-Z0-9._-]/g, "_");
  const normalizedName = safeBaseName.toLowerCase().endsWith(".csv") ? safeBaseName : `${safeBaseName}.csv`;
  const filePath = path.join(dirPath, normalizedName);

  return {
    dirPath,
    filePath,
    fileName: normalizedName,
    cleanup: async () => {
      await fs.rm(dirPath, { recursive: true, force: true });
    }
  };
}

export async function finalizeCsvExport(input: {
  filePath: string;
  fileName: string;
  columns: string[];
  rowCount: number;
}): Promise<CsvExportResult> {
  const stats = await fs.stat(input.filePath);
  return {
    filePath: input.filePath,
    fileName: input.fileName,
    columns: input.columns,
    rowCount: input.rowCount,
    bytes: stats.size,
    mimeType: "text/csv"
  };
}
