import snowflake from "snowflake-sdk";
import { createWriteStream } from "node:fs";
import type { TenantWarehouseProvider, WarehouseAdapter } from "../../core/interfaces.js";
import { buildCsvLine, createTempCsvTarget, endWritable, escapeCsvValue, finalizeCsvExport, writeWritable } from "../../core/csvExport.js";
import type { CsvExportResult, QueryResult } from "../../core/types.js";

export interface SnowflakeConfig {
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema: string;
  role?: string;
  logLevel?: snowflake.LogLevel;
  auth:
    | {
        type: "password";
        password: string;
      }
    | {
        type: "keypair";
        privateKeyPath: string;
        privateKeyPassphrase?: string;
      };
}

export class SnowflakeWarehouseAdapter implements WarehouseAdapter {
  readonly provider: TenantWarehouseProvider = "snowflake";
  private readonly connection: snowflake.Connection;
  private connected = false;

  constructor(config: SnowflakeConfig) {
    // Silence SDK connection chatter by default unless explicitly enabled.
    snowflake.configure({
      logLevel: config.logLevel ?? "OFF"
    });

    const options = {
      account: config.account,
      username: config.username,
      warehouse: config.warehouse,
      database: config.database,
      schema: config.schema,
      role: config.role
    };

    if (config.auth.type === "password") {
      (options as Record<string, unknown>).password = config.auth.password;
    } else {
      (options as Record<string, unknown>).authenticator = "SNOWFLAKE_JWT";
      (options as Record<string, unknown>).privateKeyPath = config.auth.privateKeyPath;
      if (config.auth.privateKeyPassphrase) {
        (options as Record<string, unknown>).privateKeyPass = config.auth.privateKeyPassphrase;
      }
    }

    this.connection = snowflake.createConnection(options as snowflake.ConnectionOptions);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.connection.connect((err) => {
        if (err) {
          reject(err);
          return;
        }
        this.connected = true;
        resolve();
      });
    });
  }

  async query(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult> {
    await this.ensureConnected();

    const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      this.connection.execute({
        sqlText: sql,
        complete: (err, _stmt, data) => {
          if (err) {
            reject(err);
            return;
          }
          resolve((data ?? []) as Record<string, unknown>[]);
        }
      });

      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        setTimeout(() => reject(new Error(`Snowflake query timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
      }
    });

    const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
    return {
      columns,
      rows,
      rowCount: rows.length
    };
  }

  async exportCsv(
    sql: string,
    opts?: { timeoutMs?: number; fileName?: string; pageSize?: number }
  ): Promise<CsvExportResult> {
    await this.ensureConnected();
    const target = await createTempCsvTarget(opts?.fileName);
    const stream = createWriteStream(target.filePath, { encoding: "utf8" });

    return new Promise<CsvExportResult>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const fail = async (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        stream.destroy();
        await target.cleanup();
        reject(error);
      };

      this.connection.execute({
        sqlText: sql,
        streamResult: true,
        complete: (err, stmt) => {
          if (err) {
            void fail(err);
            return;
          }
          if (!stmt) {
            void fail(new Error("Snowflake did not return a statement for export."));
            return;
          }

          const statement = stmt as unknown as {
            getColumns?: () => Array<{ getName?: () => string; name?: string }>;
            streamRows: () => NodeJS.ReadableStream;
          };
          const columns = (statement.getColumns?.() ?? [])
            .map((column) => {
              if (typeof column.getName === "function") {
                return column.getName();
              }
              return typeof column.name === "string" ? column.name : "";
            })
            .filter(Boolean);
          const rowStream = statement.streamRows();
          let rowCount = 0;

          const finish = async () => {
            if (settled) {
              return;
            }
            settled = true;
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            try {
              await endWritable(stream);
              resolve(
                await finalizeCsvExport({
                  filePath: target.filePath,
                  fileName: target.fileName,
                  columns,
                  rowCount
                })
              );
            } catch (error) {
              await target.cleanup();
              reject(error as Error);
            }
          };

          rowStream.pause();
          rowStream.on("error", (streamError) => {
            void fail(streamError as Error);
          });
          rowStream.on("data", (row) => {
            rowStream.pause();
            void writeWritable(stream, buildCsvLine(columns, row as Record<string, unknown>))
              .then(() => {
                rowCount += 1;
                rowStream.resume();
              })
              .catch((streamError) => {
                void fail(streamError as Error);
              });
          });
          rowStream.on("end", () => {
            void finish();
          });

          void (async () => {
            try {
              if (columns.length > 0) {
                await writeWritable(stream, `${columns.map((column) => escapeCsvValue(column)).join(",")}\n`);
              }
              rowStream.resume();
            } catch (writeError) {
              await fail(writeError as Error);
            }
          })();
        }
      });

      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          void fail(new Error(`Snowflake query timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
    });
  }
}
