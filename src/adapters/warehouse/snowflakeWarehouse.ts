import snowflake from "snowflake-sdk";
import { WarehouseAdapter } from "../../core/interfaces.js";
import { QueryResult } from "../../core/types.js";

export interface SnowflakeConfig {
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema: string;
  role?: string;
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
  private readonly connection: snowflake.Connection;
  private connected = false;

  constructor(config: SnowflakeConfig) {
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
}
