import { BigQuery } from "@google-cloud/bigquery";
import type { TenantWarehouseProvider, WarehouseAdapter } from "../../core/interfaces.js";
import type { QueryResult } from "../../core/types.js";

export interface BigQueryConfig {
  projectId: string;
  dataset?: string;
  location?: string;
}

export class BigQueryWarehouseAdapter implements WarehouseAdapter {
  readonly provider: TenantWarehouseProvider = "bigquery";
  private readonly client: BigQuery;
  private readonly defaultDataset: string | undefined;

  constructor(config: BigQueryConfig) {
    this.client = new BigQuery({
      projectId: config.projectId,
      location: config.location || undefined
    });
    this.defaultDataset = config.dataset || undefined;
  }

  async query(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult> {
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

    const [rows] = await this.client.query(options);
    const typedRows = rows as Record<string, unknown>[];
    const columns = typedRows.length > 0 ? Object.keys(typedRows[0] ?? {}) : [];

    return {
      columns,
      rows: typedRows,
      rowCount: typedRows.length
    };
  }
}
