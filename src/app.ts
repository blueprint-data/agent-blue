import path from "node:path";
import { env } from "./config/env.js";
import { OpenAiCompatibleProvider } from "./adapters/llm/openAiCompatibleProvider.js";
import { SqliteConversationStore } from "./adapters/store/sqliteConversationStore.js";
import { SnowflakeConfig, SnowflakeWarehouseAdapter } from "./adapters/warehouse/snowflakeWarehouse.js";
import { GitDbtRepositoryService } from "./adapters/dbt/dbtRepoService.js";
import { SqlGuard } from "./core/sqlGuard.js";
import { AnalyticsAgentRuntime } from "./core/agentRuntime.js";

export function buildStore(): SqliteConversationStore {
  const dbPath = path.join(env.appDataDir, "agent.db");
  const store = new SqliteConversationStore(dbPath);
  store.init();
  return store;
}

export function buildRuntime(store: SqliteConversationStore): AnalyticsAgentRuntime {
  const llm = buildLlmProvider();
  const warehouse = buildSnowflakeWarehouse();
  const dbtRepo = new GitDbtRepositoryService(store);
  const sqlGuard = new SqlGuard({
    enforceReadOnly: true,
    defaultLimit: 200,
    maxLimit: 2000
  });

  return new AnalyticsAgentRuntime(llm, warehouse, dbtRepo, store, sqlGuard);
}

export function buildLlmProvider(): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider(env.llmBaseUrl, env.llmApiKey, {
    "HTTP-Referer": "https://agent-blue.local",
    "X-Title": "agent-blue"
  });
}

export function buildSnowflakeConfig(): SnowflakeConfig {
  if (env.snowflakeAuthType === "keypair") {
    if (!env.snowflakePrivateKeyPath) {
      throw new Error("SNOWFLAKE_PRIVATE_KEY_PATH is required when SNOWFLAKE_AUTH_TYPE=keypair.");
    }
    return {
      account: env.snowflakeAccount,
      username: env.snowflakeUsername,
      warehouse: env.snowflakeWarehouse,
      database: env.snowflakeDatabase,
      schema: env.snowflakeSchema,
      role: env.snowflakeRole || undefined,
      auth: {
        type: "keypair",
        privateKeyPath: env.snowflakePrivateKeyPath,
        privateKeyPassphrase: env.snowflakePrivateKeyPassphrase || undefined
      }
    };
  }

  return {
    account: env.snowflakeAccount,
    username: env.snowflakeUsername,
    warehouse: env.snowflakeWarehouse,
    database: env.snowflakeDatabase,
    schema: env.snowflakeSchema,
    role: env.snowflakeRole || undefined,
    auth: {
      type: "password",
      password: env.snowflakePassword
    }
  };
}

export function buildSnowflakeWarehouse(): SnowflakeWarehouseAdapter {
  return new SnowflakeWarehouseAdapter(buildSnowflakeConfig());
}
