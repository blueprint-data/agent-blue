import { config as dotenvConfig } from "dotenv";

dotenvConfig();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
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
  snowflakeSdkLogLevel: (process.env.SNOWFLAKE_SDK_LOG_LEVEL ?? "OFF").toUpperCase(),
  bigqueryProjectId: process.env.BIGQUERY_PROJECT_ID ?? "",
  bigqueryDataset: process.env.BIGQUERY_DATASET ?? "",
  bigqueryLocation: process.env.BIGQUERY_LOCATION ?? "",
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  slackPort: Number.parseInt(process.env.SLACK_PORT ?? "3000", 10),
  slackDefaultTenantId: process.env.SLACK_DEFAULT_TENANT_ID ?? "",
  slackDefaultProfileName: process.env.SLACK_DEFAULT_PROFILE_NAME ?? "default",
  slackTeamTenantMapRaw: process.env.SLACK_TEAM_TENANT_MAP ?? "",
  slackOwnerTeamIdsRaw: process.env.SLACK_OWNER_TEAM_IDS ?? "",
  slackOwnerEnterpriseIdsRaw: process.env.SLACK_OWNER_ENTERPRISE_IDS ?? "",
  slackStrictTenantRouting: process.env.SLACK_STRICT_TENANT_ROUTING === "1" || process.env.SLACK_STRICT_TENANT_ROUTING?.toLowerCase() === "true",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramDefaultTenantId: process.env.TELEGRAM_DEFAULT_TENANT_ID ?? "",
  telegramDefaultProfileName: process.env.TELEGRAM_DEFAULT_PROFILE_NAME ?? "default",
  verboseMode: process.env.AGENT_VERBOSE === "1" || process.env.AGENT_VERBOSE?.toLowerCase() === "true",
  adminPort: Number.parseInt(process.env.ADMIN_PORT ?? "3100", 10),
  adminUsername: process.env.ADMIN_USERNAME ?? process.env.ADMIN_BASIC_USER ?? "admin",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET ?? "",
  adminSessionTtlHours: Number.parseInt(process.env.ADMIN_SESSION_TTL_HOURS ?? "12", 10),
  adminBearerToken: process.env.ADMIN_BEARER_TOKEN ?? "",
  adminBasicUser: process.env.ADMIN_BASIC_USER ?? "admin",
  adminBasicPassword: process.env.ADMIN_BASIC_PASSWORD ?? "",
  adminUiToken: process.env.ADMIN_UI_TOKEN ?? process.env.ADMIN_BEARER_TOKEN ?? "",
  adminAuthGoogleEnabled: truthyEnv(process.env.ADMIN_AUTH_GOOGLE_ENABLED),
  googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
  googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  googleOAuthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
  /** Optional; when unset, OAuth success/error redirects use the incoming request Origin. */
  adminPublicOrigin: (process.env.ADMIN_PUBLIC_ORIGIN ?? "").replace(/\/$/, ""),
  adminAuthSuperadminEmailDomainsRaw: process.env.ADMIN_AUTH_SUPERADMIN_EMAIL_DOMAINS ?? "",
  adminAuthTenantEmailDomainMapRaw: process.env.ADMIN_AUTH_TENANT_EMAIL_DOMAIN_MAP ?? "",
   schedulerTimezone: process.env.SCHEDULER_TIMEZONE ?? "UTC",
   schedulerRefreshIntervalMs: Number.parseInt(process.env.SCHEDULER_REFRESH_INTERVAL_MS ?? "60000", 10),
  require(name: string): string {
    return required(name);
  }
};
