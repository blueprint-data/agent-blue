import { BigQuery } from "@google-cloud/bigquery";
import { createWriteStream } from "node:fs";
import type { TenantWarehouseProvider, WarehouseAdapter } from "../../core/interfaces.js";
import { buildCsvLine, createTempCsvTarget, endWritable, escapeCsvValue, finalizeCsvExport, writeWritable } from "../../core/csvExport.js";
import type { CsvExportResult, QueryResult } from "../../core/types.js";

export interface BigQueryConfig {
  projectId: string;
  dataset?: string;
  location?: string;
  keyFilename?: string;
}

export class BigQueryWarehouseAdapter implements WarehouseAdapter {
  readonly provider: TenantWarehouseProvider = "bigquery";
  private readonly client: BigQuery;
  private readonly defaultDataset: string | undefined;

  constructor(config: BigQueryConfig) {
    this.client = new BigQuery({
      projectId: config.projectId,
      location: config.location || undefined,
      ...(config.keyFilename ? { keyFilename: config.keyFilename } : {})
    });
    this.defaultDataset = config.dataset || undefined;
  }

  private buildQueryOptions(sql: string, opts?: { timeoutMs?: number }): Record<string, unknown> {
    const options: Record<string, unknown> = {
      query: sql,
      useLegacySql: false
    };
    if (this.defaultDataset) {
      options.defaultDataset = { projectId: this.client.projectId, datasetId: this.defaultDataset };
    }
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      options.timeoutMs = opts.timeoutMs;
    }
    return options;
  }

  async query(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult> {
    const [rows] = await this.client.query(this.buildQueryOptions(sql, opts));
    const typedRows = rows as Record<string, unknown>[];
    const columns = typedRows.length > 0 ? Object.keys(typedRows[0] ?? {}) : [];

    return {
      columns,
      rows: typedRows,
      rowCount: typedRows.length
    };
  }

  async exportCsv(
    sql: string,
    opts?: { timeoutMs?: number; fileName?: string; pageSize?: number }
  ): Promise<CsvExportResult> {
    const target = await createTempCsvTarget(opts?.fileName);
    const stream = createWriteStream(target.filePath, { encoding: "utf8" });
    const pageSize = opts?.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, 10_000) : 1_000;
    let columns: string[] = [];
    let rowCount = 0;

    try {
      const [job] = await this.client.createQueryJob(this.buildQueryOptions(sql, opts));
      let pageToken: string | undefined;

      do {
        const [rows, nextQuery, apiResponse] = await (job as any).getQueryResults({
          autoPaginate: false,
          maxResults: pageSize,
          pageToken
        });
        const typedRows = (rows ?? []) as Record<string, unknown>[];
        if (columns.length === 0) {
          const schemaFields = Array.isArray(apiResponse?.schema?.fields)
            ? apiResponse.schema.fields
                .map((field: { name?: unknown }) => (typeof field.name === "string" ? field.name : ""))
                .filter(Boolean)
            : [];
          columns = schemaFields.length > 0 ? schemaFields : Object.keys(typedRows[0] ?? {});
          if (columns.length > 0) {
            await writeWritable(stream, `${columns.map((column) => escapeCsvValue(column)).join(",")}\n`);
          }
        }
        for (const row of typedRows) {
          await writeWritable(stream, buildCsvLine(columns, row));
          rowCount += 1;
        }
        pageToken = typeof nextQuery?.pageToken === "string" ? nextQuery.pageToken : undefined;
      } while (pageToken);

      await endWritable(stream);
      return finalizeCsvExport({
        filePath: target.filePath,
        fileName: target.fileName,
        columns,
        rowCount
      });
    } catch (error) {
      stream.destroy();
      await target.cleanup();
      throw error;
    }
  }
}
