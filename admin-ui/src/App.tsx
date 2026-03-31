import type { ReactElement, ReactNode } from "react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ApiError, apiRequest, uploadRequest } from "./api";
import { AppSidebar } from "./components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";

interface SessionState {
  authenticated: boolean;
  username?: string;
  method?: string;
  loginEnabled: boolean;
}

interface TenantRecord {
  tenantId: string;
  repoUrl: string;
  dbtSubpath: string;
  deployKeyPath: string;
  localPath: string;
  updatedAt: string;
}

interface SlackMappingsResponse {
  channels: Array<{ channelId: string; tenantId: string; source: string; updatedAt: string }>;
  users: Array<{ userId: string; tenantId: string; updatedAt: string }>;
  sharedTeams: Array<{ sharedTeamId: string; tenantId: string; updatedAt: string }>;
}

interface GuardrailsResponse {
  defaultTenantId?: string;
  ownerTeamIds: string[];
  ownerEnterpriseIds: string[];
  strictTenantRouting: boolean;
  teamTenantMap: Record<string, string>;
}

interface CredentialReference {
  tenantId: string;
  deployKeyPath?: string;
  warehouseMetadata?: Record<string, string>;
  snowflakeKeyPath?: string | null;
  snowflakeKeyUploadedAt?: string | null;
}

interface WizardStateResponse {
  tenantId: string;
  hasRepo: boolean;
  hasWarehouseConfig: boolean;
  warehouseProvider?: string;
  slackChannelCount: number;
  slackUserCount: number;
  slackSharedTeamCount: number;
}

interface ConversationSummary {
  conversationId: string;
  tenantId: string;
  profileName: string;
  source?: string;
  teamId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  latestTurnStatus?: string;
  latestUserText?: string;
  latestAssistantText?: string;
}

interface ConversationMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
}

interface ExecutionTurn {
  id: string;
  tenantId: string;
  conversationId: string;
  source: string;
  rawUserText: string;
  promptText: string;
  assistantText?: string;
  status: string;
  errorMessage?: string;
  debug?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface ConversationDetail {
  summary: ConversationSummary;
  messages: ConversationMessage[];
  executionTurns: ExecutionTurn[];
}

interface BotStatus {
  botName: string;
  desiredState: string;
  actualState: string;
  port?: number;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  updatedAt: string;
}

interface BotEvent {
  id: string;
  botName: string;
  level: "info" | "warn" | "error";
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface WarehouseConfigResponse {
  tenantId: string;
  provider: "snowflake" | "bigquery" | null;
  updatedAt?: string;
  snowflake?: {
    account: string;
    username: string;
    warehouse: string;
    database: string;
    schema: string;
    role?: string;
    authType: "keypair" | "password";
  };
  bigquery?: {
    projectId: string;
    dataset?: string;
    location?: string;
    authType?: "adc" | "service-account-key";
  };
}

interface TenantMemory {
  id: string;
  tenantId: string;
  content: string;
  source: "agent" | "manual";
  createdAt: string;
  updatedAt: string;
}

interface TelegramMapping {
  chatId: string;
  tenantId: string;
  source: string;
  updatedAt: string;
}

interface NotificationState {
  type: "success" | "error" | "info";
  text: string;
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function compactText(value?: string | null, maxLength = 120): string {
  if (!value) return "—";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function sectionError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

function StatusBadge({ label, tone }: { label: string; tone?: string }) {
  return <span className={`status-badge ${tone ?? "neutral"}`}>{label}</span>;
}

function AppShellCard(props: { title: string; subtitle?: string; action?: ReactElement; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h3>{props.title}</h3>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
        {props.action}
      </div>
      <div className="card-body">{props.children}</div>
    </section>
  );
}

function App(): ReactElement {
  const [session, setSession] = useState<SessionState | null>(null);

  const loadSession = useCallback(async () => {
    const next = await apiRequest<SessionState>("/api/admin/auth/session");
    setSession(next);
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (!session) {
    return (
      <div className="screen-center">
        <div className="splash-card">
          <span className="eyebrow">Agent Blue Admin</span>
          <h1>Loading admin session…</h1>
        </div>
      </div>
    );
  }

  if (!session.authenticated) {
    return <LoginScreen session={session} onLoggedIn={loadSession} />;
  }

  return <AdminShell session={session} onLoggedOut={loadSession} />;
}

function LoginScreen({
  session,
  onLoggedIn
}: {
  session: SessionState;
  onLoggedIn: () => Promise<void>;
}): ReactElement {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("/api/admin/auth/login", {
        method: "POST",
        body: { username, password }
      });
      setPassword("");
      await onLoggedIn();
    } catch (caught) {
      setError(sectionError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="screen-center">
      <div className="login-shell">
        <div className="login-card">
          <span className="eyebrow">Agent Blue Admin</span>
          <h1>Sign in</h1>
          <p>Secure, session-based admin access for tenant operations and Slack bot observability.</p>
          {!session.loginEnabled ? (
            <div className="banner error">Browser login is not configured. Set ADMIN_PASSWORD_HASH or ADMIN_BASIC_PASSWORD.</div>
          ) : null}
          <form onSubmit={handleSubmit} className="stack">
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            {error ? <div className="banner error">{error}</div> : null}
            <button type="submit" disabled={submitting || !session.loginEnabled}>
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function AdminShell({
  session,
  onLoggedOut
}: {
  session: SessionState;
  onLoggedOut: () => Promise<void>;
}): ReactElement {
  const [notification, setNotification] = useState<NotificationState | null>(null);

  const notify = useCallback((next: NotificationState | null) => {
    setNotification(next);
  }, []);

  async function handleLogout() {
    await apiRequest("/api/admin/auth/logout", {
      method: "POST",
      headers: {
        Origin: window.location.origin
      }
    });
    await onLoggedOut();
  }

  return (
    <SidebarProvider>
      <div className="app-shell">
        <AppSidebar username={session.username} method={session.method} onLogout={() => void handleLogout()} />
        <SidebarInset>
          <header className="content-header">
            <SidebarTrigger className="secondary-button" />
          </header>
          <main className="content">
            {notification ? <div className={`banner ${notification.type}`}>{notification.text}</div> : null}
            <Routes>
              <Route path="/" element={<OverviewPage notify={notify} />} />
              <Route path="/new-tenant" element={<NewTenantPage notify={notify} />} />
              <Route path="/tenants" element={<TenantsPage notify={notify} />} />
              <Route path="/conversations" element={<ConversationsPage notify={notify} />} />
              <Route path="/slack-bot" element={<SlackBotPage notify={notify} />} />
              <Route path="/telegram-bot" element={<TelegramBotPage notify={notify} />} />
              <Route path="/settings" element={<SettingsPage notify={notify} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}

function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle: string;
  actions?: ReactElement;
}): ReactElement {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">Admin panel</span>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {actions}
    </header>
  );
}

function OverviewPage({ notify }: { notify: (value: NotificationState | null) => void }): ReactElement {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [mappings, setMappings] = useState<SlackMappingsResponse | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [botEvents, setBotEvents] = useState<BotEvent[]>([]);
  const [telegramBotStatus, setTelegramBotStatus] = useState<BotStatus | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTenants, nextMappings, nextConversations, nextBotStatus, nextBotEvents, nextTelegramStatus] = await Promise.all([
        apiRequest<TenantRecord[]>("/api/admin/tenants"),
        apiRequest<SlackMappingsResponse>("/api/admin/slack-mappings"),
        apiRequest<ConversationSummary[]>("/api/admin/conversations?limit=6"),
        apiRequest<BotStatus>("/api/admin/bot/status"),
        apiRequest<BotEvent[]>("/api/admin/bot/events?limit=5"),
        apiRequest<BotStatus>("/api/admin/telegram-bot/status")
      ]);
      setTenants(nextTenants);
      setMappings(nextMappings);
      setConversations(nextConversations);
      setBotStatus(nextBotStatus);
      setBotEvents(nextBotEvents);
      setTelegramBotStatus(nextTelegramStatus);
    } catch (caught) {
      setError(sectionError(caught));
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  return (
    <div className="page-grid">
      <PageHeader
        title="Overview"
        subtitle="Get the current operating picture: tenants, routing health, recent conversations, and bot state."
        actions={
          <button className="secondary-button" onClick={() => void loadOverview()}>
            Refresh
          </button>
        }
      />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="stats-grid">
        <StatCard label="Tenants" value={String(tenants.length)} hint="Configured tenant workspaces" />
        <StatCard
          label="Slack mappings"
          value={
            mappings
              ? String(mappings.channels.length + mappings.users.length + mappings.sharedTeams.length)
              : loading
                ? "…"
                : "0"
          }
          hint="Channels, users, and shared teams"
        />
        <StatCard
          label="Recent conversations"
          value={String(conversations.length)}
          hint="Latest tracked execution threads"
        />
        <StatCard
          label="Slack bot"
          value={botStatus?.actualState ?? "unknown"}
          hint={botStatus?.port ? `Port ${botStatus.port}` : "Embedded supervisor"}
          tone={botStatus?.actualState === "running" ? "success" : botStatus?.actualState === "error" ? "error" : "neutral"}
        />
        <StatCard
          label="Telegram bot"
          value={telegramBotStatus?.actualState ?? "unknown"}
          hint="Long-polling supervisor"
          tone={telegramBotStatus?.actualState === "running" ? "success" : telegramBotStatus?.actualState === "error" ? "error" : "neutral"}
        />
      </div>
      <div className="two-column">
        <AppShellCard title="Recent conversations" subtitle="Latest execution threads across tenants">
          {loading ? (
            <div className="muted">Loading…</div>
          ) : conversations.length === 0 ? (
            <div className="empty-state">No conversations tracked yet.</div>
          ) : (
            <div className="list-stack">
              {conversations.map((conversation) => (
                <div key={conversation.conversationId} className="list-row">
                  <div>
                    <strong>{conversation.tenantId}</strong>
                    <div className="muted">{compactText(conversation.latestUserText)}</div>
                  </div>
                  <div className="row-meta">
                    <StatusBadge
                      label={conversation.latestTurnStatus ?? conversation.source ?? "unknown"}
                      tone={conversation.latestTurnStatus === "completed" ? "success" : "neutral"}
                    />
                    <span className="muted">{formatDate(conversation.lastMessageAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </AppShellCard>

        <AppShellCard title="Slack bot activity" subtitle="Latest embedded supervisor events">
          {loading ? (
            <div className="muted">Loading…</div>
          ) : botEvents.length === 0 ? (
            <div className="empty-state">No bot events recorded yet.</div>
          ) : (
            <div className="list-stack">
              {botEvents.map((event) => (
                <div key={event.id} className="list-row">
                  <div>
                    <strong>{event.message}</strong>
                    <div className="muted">{event.eventType}</div>
                  </div>
                  <div className="row-meta">
                    <StatusBadge label={event.level} tone={event.level === "error" ? "error" : event.level === "warn" ? "warning" : "success"} />
                    <span className="muted">{formatDate(event.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </AppShellCard>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
}): ReactElement {
  return (
    <div className={`stat-card ${tone ?? ""}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{hint}</p>
    </div>
  );
}

function NewTenantPage({ notify }: { notify: (value: NotificationState | null) => void }): ReactElement {
  const [tenantId, setTenantId] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [dbtSubpath, setDbtSubpath] = useState("models");
  const [provider, setProvider] = useState<"snowflake" | "bigquery">("snowflake");
  const [account, setAccount] = useState("");
  const [username, setUsername] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [database, setDatabase] = useState("");
  const [schema, setSchema] = useState("");
  const [role, setRole] = useState("");
  const [authType, setAuthType] = useState<"keypair" | "password">("keypair");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [passwordEnvVar, setPasswordEnvVar] = useState("SNOWFLAKE_PASSWORD");
  const [bqProjectId, setBqProjectId] = useState("");
  const [bqDataset, setBqDataset] = useState("");
  const [bqLocation, setBqLocation] = useState("");
  const [bqAuthType, setBqAuthType] = useState<"adc" | "service-account-key">("adc");
  const [channelInput, setChannelInput] = useState("");
  const [userInput, setUserInput] = useState("");
  const [teamInput, setTeamInput] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [sharedTeams, setSharedTeams] = useState<string[]>([]);
  const [wizardTenantId, setWizardTenantId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});

  async function runStep(step: string, action: () => Promise<unknown>) {
    try {
      const result = await action();
      setResults((current) => ({ ...current, [step]: JSON.stringify(result, null, 2) }));
      notify({ type: "success", text: `${step.replace(/_/g, " ")} completed.` });
    } catch (caught) {
      const message = sectionError(caught);
      setResults((current) => ({ ...current, [step]: message }));
      notify({ type: "error", text: message });
    }
  }

  return (
    <div className="page-grid">
      <PageHeader
        title="New tenant"
        subtitle="A guided setup flow for onboarding a tenant, validating access, and configuring Slack routing."
      />
      <div className="stack">
        <AppShellCard title="1. Tenant basics" subtitle="Create repo wiring and get the deploy key">
          <div className="form-grid">
            <label>
              Tenant ID
              <input value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="acme" />
            </label>
            <label>
              Repo URL
              <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="git@github.com:org/dbt.git" />
            </label>
            <label>
              dbt subpath
              <input value={dbtSubpath} onChange={(event) => setDbtSubpath(event.target.value)} />
            </label>
          </div>
          <button
            onClick={() =>
              void runStep("init", async () => {
                const response = await apiRequest<{ tenantId: string; publicKey: string; message: string }>("/api/admin/wizard/tenant/init", {
                  method: "POST",
                  body: { tenantId, repoUrl, dbtSubpath, warehouseProvider: provider }
                });
                setWizardTenantId(response.tenantId);
                return response;
              })
            }
          >
            Initialize tenant
          </button>
          {results.init ? <JsonBlock value={results.init} /> : null}
        </AppShellCard>

        <AppShellCard title="2. Verify repo access" subtitle="Confirm the deploy key works after you add it on GitHub">
          <button disabled={!wizardTenantId} onClick={() => wizardTenantId && void runStep("repo_verify", () => apiRequest(`/api/admin/wizard/tenant/${wizardTenantId}/repo-verify`, { method: "POST" }))}>
            Verify repo
          </button>
          {results.repo_verify ? <JsonBlock value={results.repo_verify} /> : null}
        </AppShellCard>

        <AppShellCard title="3. Configure warehouse" subtitle="Store tenant-specific warehouse connection settings">
          <div className="form-grid">
            <label>
              Provider
              <select value={provider} onChange={(event) => setProvider(event.target.value as "snowflake" | "bigquery")}>
                <option value="snowflake">Snowflake</option>
                <option value="bigquery">BigQuery</option>
              </select>
            </label>
            {provider === "snowflake" ? (
              <>
                <label>
                  Account
                  <input value={account} onChange={(event) => setAccount(event.target.value)} />
                </label>
                <label>
                  Username
                  <input value={username} onChange={(event) => setUsername(event.target.value)} />
                </label>
                <label>
                  Warehouse
                  <input value={warehouse} onChange={(event) => setWarehouse(event.target.value)} />
                </label>
                <label>
                  Database
                  <input value={database} onChange={(event) => setDatabase(event.target.value)} />
                </label>
                <label>
                  Schema
                  <input value={schema} onChange={(event) => setSchema(event.target.value)} />
                </label>
                <label>
                  Role
                  <input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Optional" />
                </label>
                <label>
                  Auth type
                  <select value={authType} onChange={(event) => setAuthType(event.target.value as "keypair" | "password")}>
                    <option value="keypair">Keypair</option>
                    <option value="password">Password</option>
                  </select>
                </label>
                {authType === "keypair" ? (
                  <label>
                    Private key path
                    <input value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} placeholder="/path/to/key.p8" />
                  </label>
                ) : (
                  <label>
                    Password env var
                    <input value={passwordEnvVar} onChange={(event) => setPasswordEnvVar(event.target.value)} />
                  </label>
                )}
              </>
            ) : (
              <>
                <label>
                  Project ID
                  <input value={bqProjectId} onChange={(event) => setBqProjectId(event.target.value)} placeholder="my-gcp-project" />
                </label>
                <label>
                  Dataset
                  <input value={bqDataset} onChange={(event) => setBqDataset(event.target.value)} placeholder="Optional" />
                </label>
                <label>
                  Location
                  <input value={bqLocation} onChange={(event) => setBqLocation(event.target.value)} placeholder="Optional (e.g. US, EU)" />
                </label>
                <label>
                  Auth type
                  <select value={bqAuthType} onChange={(event) => setBqAuthType(event.target.value as "adc" | "service-account-key")}>
                    <option value="adc">ADC (Application Default Credentials)</option>
                    <option value="service-account-key">Service Account Key</option>
                  </select>
                </label>
                {bqAuthType === "service-account-key" && wizardTenantId ? (
                  <label>
                    Service account key (.json)
                    <input
                      type="file"
                      accept=".json"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file && wizardTenantId) {
                          const formData = new FormData();
                          formData.append("file", file);
                          void runStep("bq_key_upload", () => uploadRequest(`/api/admin/tenants/${wizardTenantId}/bq-key-upload`, formData));
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                ) : null}
                {results.bq_key_upload ? <JsonBlock value={results.bq_key_upload} /> : null}
              </>
            )}
          </div>
          <button
            disabled={!wizardTenantId}
            onClick={() =>
              wizardTenantId &&
              void runStep("warehouse", () =>
                apiRequest(`/api/admin/wizard/tenant/${wizardTenantId}/warehouse`, {
                  method: "PUT",
                  body: provider === "snowflake"
                    ? {
                        provider: "snowflake",
                        snowflake: {
                          account,
                          username,
                          warehouse,
                          database,
                          schema,
                          role: role || undefined,
                          authType,
                          privateKeyPath: authType === "keypair" ? privateKeyPath || undefined : undefined,
                          passwordEnvVar: authType === "password" ? passwordEnvVar || undefined : undefined
                        }
                      }
                    : {
                        provider: "bigquery",
                        bigquery: {
                          projectId: bqProjectId,
                          dataset: bqDataset || undefined,
                          location: bqLocation || undefined,
                          authType: bqAuthType
                        }
                      }
                })
              )
            }
          >
            Save warehouse config
          </button>
          {results.warehouse ? <JsonBlock value={results.warehouse} /> : null}
        </AppShellCard>

        <AppShellCard title="4. Test warehouse" subtitle="Run a lightweight connection check">
          <button disabled={!wizardTenantId} onClick={() => wizardTenantId && void runStep("warehouse_test", () => apiRequest(`/api/admin/wizard/tenant/${wizardTenantId}/warehouse-test`, { method: "POST" }))}>
            Test connectivity
          </button>
          {results.warehouse_test ? <JsonBlock value={results.warehouse_test} /> : null}
        </AppShellCard>

        <AppShellCard title="5. Slack mappings" subtitle="Add the Slack contexts that should resolve to this tenant">
          <div className="chip-composer">
            <input value={channelInput} onChange={(event) => setChannelInput(event.target.value)} placeholder="Channel ID" />
            <button className="secondary-button" onClick={() => channelInput && (setChannels((current) => [...current, channelInput]), setChannelInput(""))}>
              Add channel
            </button>
            <input value={userInput} onChange={(event) => setUserInput(event.target.value)} placeholder="User ID" />
            <button className="secondary-button" onClick={() => userInput && (setUsers((current) => [...current, userInput]), setUserInput(""))}>
              Add user
            </button>
            <input value={teamInput} onChange={(event) => setTeamInput(event.target.value)} placeholder="Shared team ID" />
            <button className="secondary-button" onClick={() => teamInput && (setSharedTeams((current) => [...current, teamInput]), setTeamInput(""))}>
              Add team
            </button>
          </div>
          <div className="tag-row">
            {channels.map((entry) => <span key={entry} className="tag">{entry}</span>)}
            {users.map((entry) => <span key={entry} className="tag">{entry}</span>)}
            {sharedTeams.map((entry) => <span key={entry} className="tag">{entry}</span>)}
          </div>
          <button
            disabled={!wizardTenantId}
            onClick={() =>
              wizardTenantId &&
              void runStep("slack_mappings", () =>
                apiRequest(`/api/admin/wizard/tenant/${wizardTenantId}/slack-mappings`, {
                  method: "PUT",
                  body: {
                    channels: channels.map((channelId) => ({ channelId })),
                    users: users.map((userId) => ({ userId })),
                    sharedTeams: sharedTeams.map((sharedTeamId) => ({ sharedTeamId }))
                  }
                })
              )
            }
          >
            Save Slack mappings
          </button>
          {results.slack_mappings ? <JsonBlock value={results.slack_mappings} /> : null}
        </AppShellCard>

        <AppShellCard title="6. Final validation" subtitle="Run the final go-live checks">
          <button disabled={!wizardTenantId} onClick={() => wizardTenantId && void runStep("final_validate", () => apiRequest(`/api/admin/wizard/tenant/${wizardTenantId}/final-validate`, { method: "POST" }))}>
            Run final checks
          </button>
          {results.final_validate ? <JsonBlock value={results.final_validate} /> : null}
        </AppShellCard>
      </div>
    </div>
  );
}

function TenantsPage({ notify }: { notify: (value: NotificationState | null) => void }): ReactElement {
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialReference | null>(null);
  const [wizardState, setWizardState] = useState<WizardStateResponse | null>(null);
  const [warehouseConfig, setWarehouseConfig] = useState<WarehouseConfigResponse | null>(null);
  const [tenantMemories, setTenantMemories] = useState<TenantMemory[]>([]);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [form, setForm] = useState({ tenantId: "", repoUrl: "", dbtSubpath: "models" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingWarehouse, setSavingWarehouse] = useState(false);
  const [savingMemory, setSavingMemory] = useState(false);
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
  const [whProvider, setWhProvider] = useState<"snowflake" | "bigquery">("snowflake");
  const [whSnowflake, setWhSnowflake] = useState({ account: "", username: "", warehouse: "", database: "", schema: "", role: "", authType: "keypair" as "keypair" | "password", privateKeyPath: "", passwordEnvVar: "SNOWFLAKE_PASSWORD" });
  const [whBigQuery, setWhBigQuery] = useState({ projectId: "", dataset: "", location: "", authType: "adc" as "adc" | "service-account-key" });
  const [whEditing, setWhEditing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bqFileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.tenantId === selectedTenantId) ?? null,
    [selectedTenantId, tenants]
  );

  const loadTenants = useCallback(async () => {
    setLoading(true);
    try {
      const nextTenants = await apiRequest<TenantRecord[]>("/api/admin/tenants");
      setTenants(nextTenants);
      if (!selectedTenantId && nextTenants.length > 0) {
        setSelectedTenantId(nextTenants[0].tenantId);
      }
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoading(false);
    }
  }, [notify, selectedTenantId]);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  useEffect(() => {
    if (!selectedTenantId) {
      setCredentials(null);
      setWizardState(null);
      setWarehouseConfig(null);
      setTenantMemories([]);
      setMemoryDraft("");
      setWhEditing(false);
      return;
    }
    void (async () => {
      try {
        const [nextCredentials, nextWizardState, nextWarehouse, nextMemories] = await Promise.all([
          apiRequest<CredentialReference>(`/api/admin/credentials-ref/${selectedTenantId}`),
          apiRequest<WizardStateResponse>(`/api/admin/wizard/tenant/${selectedTenantId}/state`),
          apiRequest<WarehouseConfigResponse>(`/api/admin/tenants/${selectedTenantId}/warehouse`),
          apiRequest<TenantMemory[]>(`/api/admin/tenants/${selectedTenantId}/memories?limit=100`)
        ]);
        setCredentials(nextCredentials);
        setWizardState(nextWizardState);
        setWarehouseConfig(nextWarehouse);
        setTenantMemories(nextMemories);
        setMemoryDraft("");
        setWhEditing(false);
        if (nextWarehouse.provider === "snowflake" && nextWarehouse.snowflake) {
          setWhProvider("snowflake");
          setWhSnowflake({
            account: nextWarehouse.snowflake.account,
            username: nextWarehouse.snowflake.username,
            warehouse: nextWarehouse.snowflake.warehouse,
            database: nextWarehouse.snowflake.database,
            schema: nextWarehouse.snowflake.schema,
            role: nextWarehouse.snowflake.role ?? "",
            authType: nextWarehouse.snowflake.authType,
            privateKeyPath: "",
            passwordEnvVar: "SNOWFLAKE_PASSWORD"
          });
        } else if (nextWarehouse.provider === "bigquery" && nextWarehouse.bigquery) {
          setWhProvider("bigquery");
          setWhBigQuery({
            projectId: nextWarehouse.bigquery.projectId,
            dataset: nextWarehouse.bigquery.dataset ?? "",
            location: nextWarehouse.bigquery.location ?? "",
            authType: nextWarehouse.bigquery.authType ?? "adc"
          });
        } else {
          setWhProvider("snowflake");
        }
      } catch (caught) {
        notify({ type: "error", text: sectionError(caught) });
      }
    })();
  }, [notify, selectedTenantId]);

  useEffect(() => {
    if (!selectedTenant) return;
    setForm({
      tenantId: selectedTenant.tenantId,
      repoUrl: selectedTenant.repoUrl,
      dbtSubpath: selectedTenant.dbtSubpath
    });
  }, [selectedTenant]);

  function buildWarehousePutBody():
    | { provider: "snowflake"; snowflake: NonNullable<WarehouseConfigResponse["snowflake"]> & { privateKeyPath?: string; passwordEnvVar?: string } }
    | { provider: "bigquery"; bigquery: NonNullable<WarehouseConfigResponse["bigquery"]> & { serviceAccountKeyPath?: string } } {
    return whProvider === "snowflake"
      ? {
          provider: "snowflake",
          snowflake: {
            account: whSnowflake.account,
            username: whSnowflake.username,
            warehouse: whSnowflake.warehouse,
            database: whSnowflake.database,
            schema: whSnowflake.schema,
            role: whSnowflake.role || undefined,
            authType: whSnowflake.authType,
            privateKeyPath: whSnowflake.authType === "keypair" ? whSnowflake.privateKeyPath || undefined : undefined,
            passwordEnvVar: whSnowflake.authType === "password" ? whSnowflake.passwordEnvVar || undefined : undefined
          }
        }
      : {
          provider: "bigquery",
          bigquery: {
            projectId: whBigQuery.projectId,
            dataset: whBigQuery.dataset || undefined,
            location: whBigQuery.location || undefined,
            authType: whBigQuery.authType
          }
        };
  }

  async function putWarehouseConfig(tenantId: string): Promise<void> {
    await apiRequest(`/api/admin/wizard/tenant/${tenantId}/warehouse`, {
      method: "PUT",
      body: buildWarehousePutBody()
    });
    const nextWarehouse = await apiRequest<WarehouseConfigResponse>(`/api/admin/tenants/${tenantId}/warehouse`);
    setWarehouseConfig(nextWarehouse);
    setWhEditing(false);
  }

  async function handleSave() {
    setSaving(true);
    const persistWarehouseToo = Boolean(selectedTenant && whEditing);
    try {
      if (selectedTenant) {
        await apiRequest(`/api/admin/tenants/${selectedTenant.tenantId}`, {
          method: "PATCH",
          body: {
            repoUrl: form.repoUrl,
            dbtSubpath: form.dbtSubpath
          }
        });
        if (persistWarehouseToo) {
          setSavingWarehouse(true);
          try {
            await putWarehouseConfig(selectedTenant.tenantId);
          } finally {
            setSavingWarehouse(false);
          }
        }
        notify({
          type: "success",
          text: persistWarehouseToo
            ? `Updated ${selectedTenant.tenantId} and warehouse configuration.`
            : `Updated ${selectedTenant.tenantId}.`
        });
      } else {
        await apiRequest("/api/admin/tenants", {
          method: "POST",
          body: form
        });
        notify({ type: "success", text: `Created ${form.tenantId}.` });
        setSelectedTenantId(form.tenantId);
      }
      await loadTenants();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setSaving(false);
    }
  }

  async function saveWarehouse() {
    if (!selectedTenant) return;
    setSavingWarehouse(true);
    try {
      await putWarehouseConfig(selectedTenant.tenantId);
      notify({ type: "success", text: "Warehouse config saved." });
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setSavingWarehouse(false);
    }
  }

  async function refreshRepo() {
    if (!selectedTenant) return;
    try {
      const result = await apiRequest<{ message: string }>(`/api/admin/tenants/${selectedTenant.tenantId}/repo-refresh`, {
        method: "POST"
      });
      notify({ type: "success", text: result.message });
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function deleteTenant() {
    if (!selectedTenant) return;
    if (!window.confirm(`Delete ${selectedTenant.tenantId} and all associated data?`)) return;
    try {
      await apiRequest(`/api/admin/tenants/${selectedTenant.tenantId}`, { method: "DELETE" });
      notify({ type: "success", text: `Deleted ${selectedTenant.tenantId}.` });
      setSelectedTenantId(null);
      await loadTenants();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function uploadKey(file: File) {
    if (!selectedTenant) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const result = await uploadRequest<{ message: string }>(`/api/admin/tenants/${selectedTenant.tenantId}/key-upload`, formData);
      notify({ type: "success", text: result.message });
      const [nextCredentials, nextWarehouse] = await Promise.all([
        apiRequest<CredentialReference>(`/api/admin/credentials-ref/${selectedTenant.tenantId}`),
        apiRequest<WarehouseConfigResponse>(`/api/admin/tenants/${selectedTenant.tenantId}/warehouse`)
      ]);
      setCredentials(nextCredentials);
      setWarehouseConfig(nextWarehouse);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function uploadBqKey(file: File) {
    if (!selectedTenant) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const result = await uploadRequest<{ message: string }>(`/api/admin/tenants/${selectedTenant.tenantId}/bq-key-upload`, formData);
      notify({ type: "success", text: result.message });
      const [nextCredentials, nextWarehouse] = await Promise.all([
        apiRequest<CredentialReference>(`/api/admin/credentials-ref/${selectedTenant.tenantId}`),
        apiRequest<WarehouseConfigResponse>(`/api/admin/tenants/${selectedTenant.tenantId}/warehouse`)
      ]);
      setCredentials(nextCredentials);
      setWarehouseConfig(nextWarehouse);
      if (nextWarehouse.bigquery) {
        setWhBigQuery((c) => ({ ...c, authType: nextWarehouse.bigquery?.authType ?? "service-account-key" }));
      }
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function loadTenantMemories(tenantId: string) {
    const nextMemories = await apiRequest<TenantMemory[]>(`/api/admin/tenants/${tenantId}/memories?limit=100`);
    setTenantMemories(nextMemories);
  }

  async function addTenantMemory() {
    if (!selectedTenant) return;
    const content = memoryDraft.trim();
    if (!content) return;
    setSavingMemory(true);
    try {
      await apiRequest<TenantMemory>(`/api/admin/tenants/${selectedTenant.tenantId}/memories`, {
        method: "POST",
        body: { content }
      });
      setMemoryDraft("");
      await loadTenantMemories(selectedTenant.tenantId);
      notify({ type: "success", text: "Tenant memory added." });
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setSavingMemory(false);
    }
  }

  async function deleteTenantMemory(memoryId: string) {
    if (!selectedTenant) return;
    if (!window.confirm("Delete this tenant memory?")) return;
    setDeletingMemoryId(memoryId);
    try {
      await apiRequest(`/api/admin/tenants/${selectedTenant.tenantId}/memories/${memoryId}`, {
        method: "DELETE"
      });
      await loadTenantMemories(selectedTenant.tenantId);
      notify({ type: "success", text: "Tenant memory deleted." });
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setDeletingMemoryId(null);
    }
  }

  function warehouseSummary(): string {
    if (!warehouseConfig?.provider) return "Not configured";
    if (warehouseConfig.provider === "snowflake" && warehouseConfig.snowflake) {
      return `${warehouseConfig.snowflake.account} / ${warehouseConfig.snowflake.database}`;
    }
    if (warehouseConfig.provider === "bigquery" && warehouseConfig.bigquery) {
      return warehouseConfig.bigquery.dataset
        ? `${warehouseConfig.bigquery.projectId} / ${warehouseConfig.bigquery.dataset}`
        : warehouseConfig.bigquery.projectId;
    }
    return "Configured";
  }

  return (
    <div className="page-grid">
      <PageHeader
        title="Tenants"
        subtitle="Manage configured tenants, credential references, and day-two operational actions."
        actions={
          <button
            className="secondary-button"
            onClick={() => {
              setSelectedTenantId(null);
              setForm({ tenantId: "", repoUrl: "", dbtSubpath: "models" });
            }}
          >
            New tenant
          </button>
        }
      />
      <div className="three-column">
        <AppShellCard title="Tenant list" subtitle="Select a tenant to edit or inspect">
          {loading ? (
            <div className="muted">Loading…</div>
          ) : tenants.length === 0 ? (
            <div className="empty-state">No tenants created yet.</div>
          ) : (
            <div className="list-stack">
              {tenants.map((tenant) => (
                <button
                  key={tenant.tenantId}
                  className={`tenant-list-item ${selectedTenantId === tenant.tenantId ? "selected" : ""}`}
                  onClick={() => setSelectedTenantId(tenant.tenantId)}
                >
                  <strong>{tenant.tenantId}</strong>
                  <span>{compactText(tenant.repoUrl, 42)}</span>
                </button>
              ))}
            </div>
          )}
        </AppShellCard>

        <div className="double-stack">
          <AppShellCard
            title={selectedTenant ? `Tenant · ${selectedTenant.tenantId}` : "Create tenant"}
            subtitle="Repo configuration and primary tenant identifiers"
            action={
              <button onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving…" : selectedTenant ? "Save changes" : "Create tenant"}
              </button>
            }
          >
            <div className="form-grid">
              <label>
                Tenant ID
                <input
                  value={form.tenantId}
                  onChange={(event) => setForm((current) => ({ ...current, tenantId: event.target.value }))}
                  disabled={Boolean(selectedTenant)}
                />
              </label>
              <label>
                Repo URL
                <input value={form.repoUrl} onChange={(event) => setForm((current) => ({ ...current, repoUrl: event.target.value }))} />
              </label>
              <label>
                dbt subpath
                <input value={form.dbtSubpath} onChange={(event) => setForm((current) => ({ ...current, dbtSubpath: event.target.value }))} />
              </label>
            </div>
            {selectedTenant ? (
              <div className="button-row">
                <button className="secondary-button" onClick={() => void refreshRepo()}>
                  Refresh repo
                </button>
                {warehouseConfig?.provider === "snowflake" ? (
                  <>
                    <button className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                      Upload .p8 key
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".p8"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                          void uploadKey(file);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </>
                ) : null}
                {warehouseConfig?.provider === "bigquery" ? (
                  <>
                    <button className="secondary-button" onClick={() => bqFileInputRef.current?.click()}>
                      Upload SA key (.json)
                    </button>
                    <input
                      ref={bqFileInputRef}
                      type="file"
                      accept=".json"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                          void uploadBqKey(file);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </>
                ) : null}
                <button className="danger-button" onClick={() => void deleteTenant()}>
                  Delete tenant
                </button>
              </div>
            ) : null}
          </AppShellCard>

          <AppShellCard title="Operational metadata" subtitle="Credential references and onboarding state">
            {selectedTenant ? (
              <div className="details-grid">
                <DetailItem label="Deploy key" value={credentials?.deployKeyPath ?? "—"} />
                <DetailItem label="Warehouse provider" value={warehouseConfig?.provider ?? "Not configured"} />
                <DetailItem label="Warehouse details" value={warehouseSummary()} />
                {warehouseConfig?.provider === "snowflake" ? (
                  <>
                    <DetailItem label="Snowflake .p8" value={credentials?.snowflakeKeyPath ?? "—"} />
                    <DetailItem label="Key uploaded" value={formatDate(credentials?.snowflakeKeyUploadedAt)} />
                  </>
                ) : null}
                <DetailItem label="Slack channels" value={String(wizardState?.slackChannelCount ?? 0)} />
                <DetailItem label="Slack users" value={String(wizardState?.slackUserCount ?? 0)} />
                <DetailItem label="Shared teams" value={String(wizardState?.slackSharedTeamCount ?? 0)} />
                <DetailItem label="Updated" value={formatDate(selectedTenant.updatedAt)} />
              </div>
            ) : (
              <div className="empty-state">Create or select a tenant to inspect operational state.</div>
            )}
          </AppShellCard>

          <AppShellCard title="Tenant memories" subtitle="View the saved tenant facts that will be available to future conversations.">
            {!selectedTenant ? (
              <div className="empty-state">Select a tenant to manage tenant memories.</div>
            ) : (
              <div className="stack">
                <label>
                  Add manual memory
                  <textarea
                    rows={3}
                    value={memoryDraft}
                    maxLength={300}
                    onChange={(event) => setMemoryDraft(event.target.value)}
                    placeholder="Example: Revenue means gross revenue unless the user explicitly asks for net revenue."
                  />
                </label>
                <div className="button-row">
                  <button onClick={() => void addTenantMemory()} disabled={savingMemory || memoryDraft.trim().length === 0}>
                    {savingMemory ? "Adding…" : "Add memory"}
                  </button>
                  <span className="muted">{memoryDraft.trim().length}/300</span>
                </div>
                {tenantMemories.length === 0 ? (
                  <div className="empty-state">No tenant memories saved yet.</div>
                ) : (
                  <div className="stack">
                    {tenantMemories.map((memory) => (
                      <div key={memory.id} className="turn-card">
                        <div className="turn-header">
                          <div>
                            <strong>{memory.content}</strong>
                            <div className="muted">
                              {memory.source} · created {formatDate(memory.createdAt)} · updated {formatDate(memory.updatedAt)}
                            </div>
                          </div>
                          <button
                            className="danger-button small"
                            onClick={() => void deleteTenantMemory(memory.id)}
                            disabled={deletingMemoryId === memory.id}
                          >
                            {deletingMemoryId === memory.id ? "Deleting…" : "Delete"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </AppShellCard>

          {selectedTenant ? (
            <AppShellCard
              title="Warehouse configuration"
              subtitle="View or edit the warehouse connection for this tenant"
              action={
                whEditing ? (
                  <div className="button-row">
                    <button onClick={() => void saveWarehouse()} disabled={savingWarehouse}>
                      {savingWarehouse ? "Saving…" : "Save"}
                    </button>
                    <button className="secondary-button" onClick={() => setWhEditing(false)}>Cancel</button>
                  </div>
                ) : (
                  <button className="secondary-button" onClick={() => setWhEditing(true)}>Edit</button>
                )
              }
            >
              {whEditing ? (
                <div className="form-grid">
                  <label>
                    Provider
                    <select value={whProvider} onChange={(event) => setWhProvider(event.target.value as "snowflake" | "bigquery")}>
                      <option value="snowflake">Snowflake</option>
                      <option value="bigquery">BigQuery</option>
                    </select>
                  </label>
                  {whProvider === "snowflake" ? (
                    <>
                      <label>Account<input value={whSnowflake.account} onChange={(e) => setWhSnowflake((c) => ({ ...c, account: e.target.value }))} /></label>
                      <label>Username<input value={whSnowflake.username} onChange={(e) => setWhSnowflake((c) => ({ ...c, username: e.target.value }))} /></label>
                      <label>Warehouse<input value={whSnowflake.warehouse} onChange={(e) => setWhSnowflake((c) => ({ ...c, warehouse: e.target.value }))} /></label>
                      <label>Database<input value={whSnowflake.database} onChange={(e) => setWhSnowflake((c) => ({ ...c, database: e.target.value }))} /></label>
                      <label>Schema<input value={whSnowflake.schema} onChange={(e) => setWhSnowflake((c) => ({ ...c, schema: e.target.value }))} /></label>
                      <label>Role<input value={whSnowflake.role} onChange={(e) => setWhSnowflake((c) => ({ ...c, role: e.target.value }))} placeholder="Optional" /></label>
                      <label>
                        Auth type
                        <select value={whSnowflake.authType} onChange={(e) => setWhSnowflake((c) => ({ ...c, authType: e.target.value as "keypair" | "password" }))}>
                          <option value="keypair">Keypair</option>
                          <option value="password">Password</option>
                        </select>
                      </label>
                      {whSnowflake.authType === "keypair" ? (
                        <label>Private key path<input value={whSnowflake.privateKeyPath} onChange={(e) => setWhSnowflake((c) => ({ ...c, privateKeyPath: e.target.value }))} placeholder="/path/to/key.p8" /></label>
                      ) : (
                        <label>Password env var<input value={whSnowflake.passwordEnvVar} onChange={(e) => setWhSnowflake((c) => ({ ...c, passwordEnvVar: e.target.value }))} /></label>
                      )}
                    </>
                  ) : (
                    <>
                      <label>Project ID<input value={whBigQuery.projectId} onChange={(e) => setWhBigQuery((c) => ({ ...c, projectId: e.target.value }))} placeholder="my-gcp-project" /></label>
                      <label>Dataset<input value={whBigQuery.dataset} onChange={(e) => setWhBigQuery((c) => ({ ...c, dataset: e.target.value }))} placeholder="Optional" /></label>
                      <label>Location<input value={whBigQuery.location} onChange={(e) => setWhBigQuery((c) => ({ ...c, location: e.target.value }))} placeholder="Optional (e.g. US, EU)" /></label>
                      <label>
                        Auth type
                        <select value={whBigQuery.authType} onChange={(e) => setWhBigQuery((c) => ({ ...c, authType: e.target.value as "adc" | "service-account-key" }))}>
                          <option value="adc">ADC (Application Default Credentials)</option>
                          <option value="service-account-key">Service Account Key</option>
                        </select>
                      </label>
                    </>
                  )}
                </div>
              ) : warehouseConfig?.provider ? (
                <div className="details-grid">
                  <DetailItem label="Provider" value={warehouseConfig.provider} />
                  {warehouseConfig.provider === "snowflake" && warehouseConfig.snowflake ? (
                    <>
                      <DetailItem label="Account" value={warehouseConfig.snowflake.account} />
                      <DetailItem label="Username" value={warehouseConfig.snowflake.username} />
                      <DetailItem label="Warehouse" value={warehouseConfig.snowflake.warehouse} />
                      <DetailItem label="Database" value={warehouseConfig.snowflake.database} />
                      <DetailItem label="Schema" value={warehouseConfig.snowflake.schema} />
                      <DetailItem label="Role" value={warehouseConfig.snowflake.role ?? "—"} />
                      <DetailItem label="Auth type" value={warehouseConfig.snowflake.authType} />
                    </>
                  ) : null}
                  {warehouseConfig.provider === "bigquery" && warehouseConfig.bigquery ? (
                    <>
                      <DetailItem label="Project ID" value={warehouseConfig.bigquery.projectId} />
                      <DetailItem label="Dataset" value={warehouseConfig.bigquery.dataset ?? "—"} />
                      <DetailItem label="Location" value={warehouseConfig.bigquery.location ?? "—"} />
                      <DetailItem label="Auth type" value={warehouseConfig.bigquery.authType === "service-account-key" ? "Service Account Key" : "ADC"} />
                    </>
                  ) : null}
                  {warehouseConfig.updatedAt ? <DetailItem label="Updated" value={formatDate(warehouseConfig.updatedAt)} /> : null}
                </div>
              ) : (
                <div className="empty-state">No warehouse configured. Click Edit to set one up.</div>
              )}
            </AppShellCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConversationsPage({ notify }: { notify: (value: NotificationState | null) => void }): ReactElement {
  const [filters, setFilters] = useState({ tenantId: "", source: "", search: "" });
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.tenantId) params.set("tenantId", filters.tenantId);
      if (filters.source) params.set("source", filters.source);
      if (filters.search) params.set("search", filters.search);
      params.set("limit", "50");
      const nextItems = await apiRequest<ConversationSummary[]>(`/api/admin/conversations?${params.toString()}`);
      setItems(nextItems);
      if (!selectedId && nextItems.length > 0) {
        setSelectedId(nextItems[0].conversationId);
      }
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoading(false);
    }
  }, [filters, notify, selectedId]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void (async () => {
      try {
        setDetail(await apiRequest<ConversationDetail>(`/api/admin/conversations/${selectedId}`));
      } catch (caught) {
        notify({ type: "error", text: sectionError(caught) });
      }
    })();
  }, [notify, selectedId]);

  return (
    <div className="page-grid">
      <PageHeader title="Conversations" subtitle="Inspect raw messages, execution turns, SQL/debug traces, and Slack origin metadata." />
      <AppShellCard title="Filters" subtitle="Slice by tenant, source, or message text">
        <div className="filters-row">
          <input placeholder="Tenant ID" value={filters.tenantId} onChange={(event) => setFilters((current) => ({ ...current, tenantId: event.target.value }))} />
          <select value={filters.source} onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))}>
            <option value="">All sources</option>
            <option value="cli">CLI</option>
            <option value="slack">Slack</option>
            <option value="admin">Admin</option>
          </select>
          <input placeholder="Search user / assistant text" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} />
          <button onClick={() => void loadConversations()}>Apply</button>
        </div>
      </AppShellCard>
      <div className="three-column">
        <AppShellCard title="Conversation list" subtitle="Newest threads first">
          {loading ? (
            <div className="muted">Loading…</div>
          ) : items.length === 0 ? (
            <div className="empty-state">No conversations match your filters.</div>
          ) : (
            <div className="list-stack">
              {items.map((item) => (
                <button
                  key={item.conversationId}
                  className={`tenant-list-item ${selectedId === item.conversationId ? "selected" : ""}`}
                  onClick={() => setSelectedId(item.conversationId)}
                >
                  <strong>{item.tenantId}</strong>
                  <span>{compactText(item.latestUserText)}</span>
                </button>
              ))}
            </div>
          )}
        </AppShellCard>
        <div className="double-stack">
          <AppShellCard title="Conversation detail" subtitle="Raw message timeline for the selected thread">
            {!detail ? (
              <div className="empty-state">Select a conversation to inspect.</div>
            ) : (
              <>
                <div className="details-grid">
                  <DetailItem label="Tenant" value={detail.summary.tenantId} />
                  <DetailItem label="Source" value={detail.summary.source ?? "—"} />
                  <DetailItem label="Channel" value={detail.summary.channelId ?? "—"} />
                  <DetailItem label="Thread" value={detail.summary.threadTs ?? "—"} />
                  <DetailItem label="Latest status" value={detail.summary.latestTurnStatus ?? "—"} />
                  <DetailItem label="Last activity" value={formatDate(detail.summary.lastMessageAt)} />
                </div>
                <div className="timeline">
                  {detail.messages.map((message) => (
                    <div key={message.id} className={`message-bubble ${message.role}`}>
                      <div className="message-meta">
                        <strong>{message.role}</strong>
                        <span>{formatDate(message.createdAt)}</span>
                      </div>
                      <div className="message-text">{message.content}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </AppShellCard>
          <AppShellCard title="Execution turns" subtitle="Stored prompt vs raw request, assistant result, and debug payload">
            {!detail ? (
              <div className="empty-state">Execution detail will appear here once you choose a conversation.</div>
            ) : (
              <div className="stack">
                {detail.executionTurns.map((turn) => (
                  <div key={turn.id} className="turn-card">
                    <div className="turn-header">
                      <div>
                        <strong>{turn.id}</strong>
                        <div className="muted">{formatDate(turn.createdAt)}</div>
                      </div>
                      <StatusBadge
                        label={turn.status}
                        tone={turn.status === "completed" ? "success" : turn.status === "failed" ? "error" : "warning"}
                      />
                    </div>
                    <DetailItem label="Raw user text" value={turn.rawUserText} multiline />
                    <DetailItem label="Prompt text" value={turn.promptText} multiline />
                    <DetailItem label="Assistant text" value={turn.assistantText ?? "—"} multiline />
                    {turn.errorMessage ? <DetailItem label="Error" value={turn.errorMessage} multiline /> : null}
                    {turn.debug ? <JsonBlock value={turn.debug} /> : null}
                  </div>
                ))}
              </div>
            )}
          </AppShellCard>
        </div>
      </div>
    </div>
  );
}

function SlackBotPage({ notify }: { notify: (value: NotificationState | null) => void }): ReactElement {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const loadBotData = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextEvents] = await Promise.all([
        apiRequest<BotStatus>("/api/admin/bot/status"),
        apiRequest<BotEvent[]>("/api/admin/bot/events?limit=40")
      ]);
      setStatus(nextStatus);
      setEvents(nextEvents);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadBotData();
  }, [loadBotData]);

  async function invoke(action: "start" | "stop" | "restart") {
    try {
      const result = await apiRequest<BotStatus>(`/api/admin/bot/${action}`, {
        method: "POST",
        headers: {
          Origin: window.location.origin
        },
        body: {}
      });
      setStatus(result);
      notify({ type: "success", text: `Slack bot ${action} requested.` });
      await loadBotData();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  return (
    <div className="page-grid">
      <PageHeader
        title="Slack bot"
        subtitle="View embedded bot status, start/stop it, and inspect recent operational events."
        actions={
          <button className="secondary-button" onClick={() => void loadBotData()}>
            Refresh
          </button>
        }
      />
      <div className="two-column">
        <AppShellCard title="Bot status" subtitle="Current desired/actual runtime state and recent lifecycle timestamps">
          {loading || !status ? (
            <div className="muted">Loading…</div>
          ) : (
            <>
              <div className="details-grid">
                <DetailItem label="Bot name" value={status.botName} />
                <DetailItem label="Desired state" value={status.desiredState} />
                <DetailItem label="Actual state" value={status.actualState} />
                <DetailItem label="Port" value={String(status.port ?? "—")} />
                <DetailItem label="Last started" value={formatDate(status.lastStartedAt)} />
                <DetailItem label="Last stopped" value={formatDate(status.lastStoppedAt)} />
                <DetailItem label="Last error" value={formatDate(status.lastErrorAt)} />
                <DetailItem label="Error message" value={status.lastErrorMessage ?? "—"} multiline />
              </div>
              <div className="button-row">
                <button onClick={() => void invoke("start")}>Start</button>
                <button className="secondary-button" onClick={() => void invoke("restart")}>
                  Restart
                </button>
                <button className="danger-button" onClick={() => void invoke("stop")}>
                  Stop
                </button>
              </div>
            </>
          )}
        </AppShellCard>

        <AppShellCard title="Recent bot events" subtitle="Lifecycle and processing events emitted by the embedded supervisor">
          {loading ? (
            <div className="muted">Loading…</div>
          ) : events.length === 0 ? (
            <div className="empty-state">No events recorded yet.</div>
          ) : (
            <div className="stack">
              {events.map((event) => (
                <div key={event.id} className="turn-card">
                  <div className="turn-header">
                    <div>
                      <strong>{event.message}</strong>
                      <div className="muted">
                        {event.eventType} · {formatDate(event.createdAt)}
                      </div>
                    </div>
                    <StatusBadge label={event.level} tone={event.level === "error" ? "error" : event.level === "warn" ? "warning" : "success"} />
                  </div>
                  {event.metadata ? <JsonBlock value={event.metadata} /> : null}
                </div>
              ))}
            </div>
          )}
        </AppShellCard>
      </div>
    </div>
  );
}

function TelegramBotPage({ notify }: { notify: (value: NotificationState | null) => void }): ReactElement {
  const [mappings, setMappings] = useState<TelegramMapping[]>([]);
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [botEvents, setBotEvents] = useState<BotEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [chatId, setChatId] = useState("");
  const [tenantId, setTenantId] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [nextMappings, nextTenants, nextStatus, nextEvents] = await Promise.all([
        apiRequest<TelegramMapping[]>("/api/admin/telegram-mappings"),
        apiRequest<TenantRecord[]>("/api/admin/tenants"),
        apiRequest<BotStatus>("/api/admin/telegram-bot/status"),
        apiRequest<BotEvent[]>("/api/admin/telegram-bot/events?limit=40")
      ]);
      setMappings(nextMappings);
      setTenants(nextTenants);
      setBotStatus(nextStatus);
      setBotEvents(nextEvents);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function invokeBot(action: "start" | "stop" | "restart") {
    try {
      const result = await apiRequest<BotStatus>(`/api/admin/telegram-bot/${action}`, {
        method: "POST",
        body: {}
      });
      setBotStatus(result);
      notify({ type: "success", text: `Telegram bot ${action} requested.` });
      await loadData();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function addMapping() {
    if (!chatId || !tenantId) return;
    try {
      await apiRequest(`/api/admin/telegram-mappings/${chatId}`, {
        method: "PUT",
        body: { tenantId }
      });
      notify({ type: "success", text: `Mapped chat ${chatId} to tenant ${tenantId}.` });
      setChatId("");
      setTenantId("");
      await loadData();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function deleteMapping(id: string) {
    try {
      await apiRequest(`/api/admin/telegram-mappings/${id}`, { method: "DELETE" });
      notify({ type: "success", text: "Mapping deleted." });
      await loadData();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  return (
    <div className="page-grid">
      <PageHeader
        title="Telegram bot"
        subtitle="Control the Telegram bot lifecycle, manage chat-to-tenant routing, and inspect operational events."
        actions={
          <button className="secondary-button" onClick={() => void loadData()}>
            Refresh
          </button>
        }
      />
      <div className="two-column">
        <AppShellCard title="Bot status" subtitle="Current desired/actual runtime state and recent lifecycle timestamps">
          {loading || !botStatus ? (
            <div className="muted">Loading…</div>
          ) : (
            <>
              <div className="details-grid">
                <DetailItem label="Bot name" value={botStatus.botName} />
                <DetailItem label="Desired state" value={botStatus.desiredState} />
                <DetailItem label="Actual state" value={botStatus.actualState} />
                <DetailItem label="Last started" value={formatDate(botStatus.lastStartedAt)} />
                <DetailItem label="Last stopped" value={formatDate(botStatus.lastStoppedAt)} />
                <DetailItem label="Last error" value={formatDate(botStatus.lastErrorAt)} />
                <DetailItem label="Error message" value={botStatus.lastErrorMessage ?? "—"} multiline />
              </div>
              <div className="button-row">
                <button onClick={() => void invokeBot("start")}>Start</button>
                <button className="secondary-button" onClick={() => void invokeBot("restart")}>
                  Restart
                </button>
                <button className="danger-button" onClick={() => void invokeBot("stop")}>
                  Stop
                </button>
              </div>
            </>
          )}
        </AppShellCard>

        <AppShellCard title="Recent bot events" subtitle="Lifecycle and processing events emitted by the Telegram bot supervisor">
          {loading ? (
            <div className="muted">Loading…</div>
          ) : botEvents.length === 0 ? (
            <div className="empty-state">No events recorded yet.</div>
          ) : (
            <div className="stack">
              {botEvents.map((event) => (
                <div key={event.id} className="turn-card">
                  <div className="turn-header">
                    <div>
                      <strong>{event.message}</strong>
                      <div className="muted">
                        {event.eventType} · {formatDate(event.createdAt)}
                      </div>
                    </div>
                    <StatusBadge label={event.level} tone={event.level === "error" ? "error" : event.level === "warn" ? "warning" : "success"} />
                  </div>
                  {event.metadata ? <JsonBlock value={event.metadata} /> : null}
                </div>
              ))}
            </div>
          )}
        </AppShellCard>
      </div>
      <div className="two-column">
        <AppShellCard title="Chat-to-tenant mappings" subtitle="Route Telegram chats to specific tenants">
          <div className="filters-row">
            <input placeholder="Chat ID" value={chatId} onChange={(event) => setChatId(event.target.value)} />
            <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
              <option value="">Select tenant…</option>
              {tenants.map((tenant) => (
                <option key={tenant.tenantId} value={tenant.tenantId}>{tenant.tenantId}</option>
              ))}
            </select>
            <button className="secondary-button" onClick={() => void addMapping()} disabled={!chatId || !tenantId}>
              Add mapping
            </button>
          </div>
          {loading ? (
            <div className="muted">Loading…</div>
          ) : mappings.length === 0 ? (
            <div className="empty-state">No Telegram chat mappings yet.</div>
          ) : (
            <div className="list-stack">
              {mappings.map((mapping) => (
                <div key={mapping.chatId} className="list-row">
                  <div>
                    <strong>{mapping.chatId}</strong>
                    <div className="muted">{mapping.tenantId}{mapping.source ? ` · ${mapping.source}` : ""} · {formatDate(mapping.updatedAt)}</div>
                  </div>
                  <button className="danger-button small" onClick={() => void deleteMapping(mapping.chatId)}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </AppShellCard>

        <AppShellCard title="Configuration reference" subtitle="Environment variables required for the Telegram bot">
          <div className="details-grid">
            <DetailItem label="TELEGRAM_BOT_TOKEN" value="Bot token from @BotFather (required)" />
            <DetailItem label="TELEGRAM_DEFAULT_TENANT_ID" value="Fallback tenant for unmapped chats (optional)" />
            <DetailItem label="TELEGRAM_DEFAULT_PROFILE_NAME" value="Agent profile name (default: 'default')" />
          </div>
        </AppShellCard>
      </div>
    </div>
  );
}

function SettingsPage({ notify }: { notify: (value: NotificationState | null) => void }): ReactElement {
  const [guardrails, setGuardrails] = useState<GuardrailsResponse | null>(null);
  const [mappings, setMappings] = useState<SlackMappingsResponse | null>(null);
  const [teamTenantMapText, setTeamTenantMapText] = useState("{}");
  const [mappingDrafts, setMappingDrafts] = useState({ channelId: "", channelTenantId: "", userId: "", userTenantId: "", teamId: "", teamTenantId: "" });

  const loadSettings = useCallback(async () => {
    try {
      const [nextGuardrails, nextMappings] = await Promise.all([
        apiRequest<GuardrailsResponse>("/api/admin/guardrails"),
        apiRequest<SlackMappingsResponse>("/api/admin/slack-mappings")
      ]);
      setGuardrails(nextGuardrails);
      setTeamTenantMapText(JSON.stringify(nextGuardrails.teamTenantMap, null, 2));
      setMappings(nextMappings);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }, [notify]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function saveGuardrails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guardrails) return;
    try {
      const parsedTeamTenantMap = JSON.parse(teamTenantMapText) as Record<string, string>;
      await apiRequest("/api/admin/guardrails", {
        method: "PATCH",
        body: {
          ...guardrails,
          teamTenantMap: parsedTeamTenantMap
        }
      });
      notify({ type: "success", text: "Guardrails saved." });
      await loadSettings();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function saveMapping(kind: "channels" | "users" | "shared-teams", id: string, tenantId: string) {
    try {
      await apiRequest(`/api/admin/slack-mappings/${kind}/${id}`, {
        method: "PUT",
        body: { tenantId }
      });
      notify({ type: "success", text: `Saved ${kind} mapping.` });
      setMappingDrafts({ channelId: "", channelTenantId: "", userId: "", userTenantId: "", teamId: "", teamTenantId: "" });
      await loadSettings();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function deleteMapping(kind: "channels" | "users" | "shared-teams", id: string) {
    try {
      await apiRequest(`/api/admin/slack-mappings/${kind}/${id}`, {
        method: "DELETE"
      });
      notify({ type: "success", text: "Mapping deleted." });
      await loadSettings();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  return (
    <div className="page-grid">
      <PageHeader title="Settings" subtitle="Slack routing defaults, guardrails, and global mapping management." />
      <div className="two-column">
        <AppShellCard title="Guardrails" subtitle="Owner defaults, strict routing, and workspace fallback map">
          {!guardrails ? (
            <div className="muted">Loading…</div>
          ) : (
            <form className="stack" onSubmit={saveGuardrails}>
              <label>
                Default tenant ID
                <input value={guardrails.defaultTenantId ?? ""} onChange={(event) => setGuardrails((current) => current ? { ...current, defaultTenantId: event.target.value } : current)} />
              </label>
              <label>
                Owner team IDs
                <input
                  value={guardrails.ownerTeamIds.join(", ")}
                  onChange={(event) =>
                    setGuardrails((current) =>
                      current
                        ? {
                            ...current,
                            ownerTeamIds: event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean)
                          }
                        : current
                    )
                  }
                />
              </label>
              <label>
                Owner enterprise IDs
                <input
                  value={guardrails.ownerEnterpriseIds.join(", ")}
                  onChange={(event) =>
                    setGuardrails((current) =>
                      current
                        ? {
                            ...current,
                            ownerEnterpriseIds: event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean)
                          }
                        : current
                    )
                  }
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={guardrails.strictTenantRouting}
                  onChange={(event) => setGuardrails((current) => current ? { ...current, strictTenantRouting: event.target.checked } : current)}
                />
                Strict tenant routing
              </label>
              <label>
                Team → tenant map (JSON)
                <textarea
                  rows={8}
                  value={teamTenantMapText}
                  onChange={(event) => setTeamTenantMapText(event.target.value)}
                />
              </label>
              <button type="submit">Save guardrails</button>
            </form>
          )}
        </AppShellCard>

        <AppShellCard title="Slack mappings" subtitle="Manage explicit channel, user, and shared-team tenant routing">
          {!mappings ? (
            <div className="muted">Loading…</div>
          ) : (
            <div className="stack">
              <MappingEditor
                label="Channel"
                idValue={mappingDrafts.channelId}
                tenantValue={mappingDrafts.channelTenantId}
                onIdChange={(value) => setMappingDrafts((current) => ({ ...current, channelId: value }))}
                onTenantChange={(value) => setMappingDrafts((current) => ({ ...current, channelTenantId: value }))}
                onSave={() => void saveMapping("channels", mappingDrafts.channelId, mappingDrafts.channelTenantId)}
              />
              <MappingEditor
                label="User"
                idValue={mappingDrafts.userId}
                tenantValue={mappingDrafts.userTenantId}
                onIdChange={(value) => setMappingDrafts((current) => ({ ...current, userId: value }))}
                onTenantChange={(value) => setMappingDrafts((current) => ({ ...current, userTenantId: value }))}
                onSave={() => void saveMapping("users", mappingDrafts.userId, mappingDrafts.userTenantId)}
              />
              <MappingEditor
                label="Shared team"
                idValue={mappingDrafts.teamId}
                tenantValue={mappingDrafts.teamTenantId}
                onIdChange={(value) => setMappingDrafts((current) => ({ ...current, teamId: value }))}
                onTenantChange={(value) => setMappingDrafts((current) => ({ ...current, teamTenantId: value }))}
                onSave={() => void saveMapping("shared-teams", mappingDrafts.teamId, mappingDrafts.teamTenantId)}
              />
              <MappingTable title="Channels" items={mappings.channels.map((entry) => ({ id: entry.channelId, tenantId: entry.tenantId, meta: entry.source }))} onDelete={(id) => void deleteMapping("channels", id)} />
              <MappingTable title="Users" items={mappings.users.map((entry) => ({ id: entry.userId, tenantId: entry.tenantId }))} onDelete={(id) => void deleteMapping("users", id)} />
              <MappingTable title="Shared teams" items={mappings.sharedTeams.map((entry) => ({ id: entry.sharedTeamId, tenantId: entry.tenantId }))} onDelete={(id) => void deleteMapping("shared-teams", id)} />
            </div>
          )}
        </AppShellCard>
      </div>
    </div>
  );
}

function MappingEditor({
  label,
  idValue,
  tenantValue,
  onIdChange,
  onTenantChange,
  onSave
}: {
  label: string;
  idValue: string;
  tenantValue: string;
  onIdChange: (value: string) => void;
  onTenantChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="filters-row">
      <input placeholder={`${label} ID`} value={idValue} onChange={(event) => onIdChange(event.target.value)} />
      <input placeholder="Tenant ID" value={tenantValue} onChange={(event) => onTenantChange(event.target.value)} />
      <button className="secondary-button" onClick={onSave}>
        Save {label.toLowerCase()}
      </button>
    </div>
  );
}

function MappingTable({
  title,
  items,
  onDelete
}: {
  title: string;
  items: Array<{ id: string; tenantId: string; meta?: string }>;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="stack">
      <div className="subsection-title">{title}</div>
      {items.length === 0 ? (
        <div className="empty-state">No mappings yet.</div>
      ) : (
        items.map((item) => (
          <div key={item.id} className="list-row">
            <div>
              <strong>{item.id}</strong>
              <div className="muted">{item.tenantId}{item.meta ? ` · ${item.meta}` : ""}</div>
            </div>
            <button className="danger-button small" onClick={() => onDelete(item.id)}>
              Delete
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function DetailItem({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className={`detail-item ${multiline ? "full-width" : ""}`}>
      <span>{label}</span>
      <strong className={multiline ? "multiline" : ""}>{value}</strong>
    </div>
  );
}

export default App;
