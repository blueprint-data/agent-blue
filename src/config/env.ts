import { config as dotenvConfig } from "dotenv";

dotenvConfig();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  appDataDir: process.env.APP_DATA_DIR ?? "data",
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "openai/gpt-4o-mini",
  snowflakeAuthType: (process.env.SNOWFLAKE_AUTH_TYPE ?? "password") as "password" | "keypair",
  snowflakeAccount: process.env.SNOWFLAKE_ACCOUNT ?? "",
  snowflakeUsername: process.env.SNOWFLAKE_USERNAME ?? "",
  snowflakePassword: process.env.SNOWFLAKE_PASSWORD ?? "",
  snowflakePrivateKeyPath: process.env.SNOWFLAKE_PRIVATE_KEY_PATH ?? "",
  snowflakePrivateKeyPassphrase: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE ?? "",
  snowflakeWarehouse: process.env.SNOWFLAKE_WAREHOUSE ?? "",
  snowflakeDatabase: process.env.SNOWFLAKE_DATABASE ?? "",
  snowflakeSchema: process.env.SNOWFLAKE_SCHEMA ?? "",
  snowflakeRole: process.env.SNOWFLAKE_ROLE ?? "",
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  slackPort: Number.parseInt(process.env.SLACK_PORT ?? "3000", 10),
  slackDefaultTenantId: process.env.SLACK_DEFAULT_TENANT_ID ?? "",
  slackDefaultProfileName: process.env.SLACK_DEFAULT_PROFILE_NAME ?? "default",
  slackTeamTenantMapRaw: process.env.SLACK_TEAM_TENANT_MAP ?? "",
  require(name: string): string {
    return required(name);
  }
};
