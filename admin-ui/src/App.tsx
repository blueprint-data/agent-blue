import type { ReactElement, ReactNode } from "react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ApiError, apiRequest, uploadRequest } from "./api";
import { AppSidebar } from "./components/app-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";

interface SessionState {
  authenticated: boolean;
  username?: string;
  method?: string;
  loginEnabled: boolean;
  googleLoginEnabled?: boolean;
  passwordLoginEnabled?: boolean;
  role?: "superadmin" | "tenant_admin";
  scopedTenantId?: string;
  email?: string;
  authProvider?: "password" | "google";
}

interface TenantRecord {
  tenantId: string;
  repoUrl: string;
  dbtSubpath: string;
  deployKeyPath: string;
  localPath: string;
  updatedAt: string;
  hasSlackBotOverride?: boolean;
  hasTelegramBotOverride?: boolean;
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
  hasSlackBotOverride?: boolean;
  hasTelegramBotOverride?: boolean;
  slackEventsPathSuffix?: string;
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

interface TenantScheduleRecord {
  id: string;
  tenantId: string;
  userRequest: string;
  cron: string;
  channelType: "slack" | "telegram" | "console" | "custom";
  channelRef?: string | null;
  active: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleChannelOptions {
  slackChannels: Array<{ channelId: string; source: string }>;
  telegramChats: Array<{ chatId: string; source: string }>;
}

/** Scheduler log lines from GET /api/admin/scheduler/events (same shape as AdminBotEvent). */
interface SchedulerBotEventRecord {
  id: string;
  botName: string;
  level: "info" | "warn" | "error";
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
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
    <section className="bp-card">
      <div className="flex items-start justify-between px-6 pt-6 pb-4">
        <div>
          <h3 className="font-semibold leading-none tracking-tight text-[var(--semantic-text-strong)]">{props.title}</h3>
          {props.subtitle ? <p className="text-sm text-[var(--semantic-text-body)] mt-1.5">{props.subtitle}</p> : null}
        </div>
        {props.action}
      </div>
      <div className="px-6 pb-6 flex flex-col gap-4">{props.children}</div>
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
          <h1 className="hero-title">Loading admin session…</h1>
        </div>
      </div>
    );
  }

  if (!session.authenticated) {
    return <LoginScreen session={session} onLoggedIn={loadSession} />;
  }

  return <AdminShell session={session} onLoggedOut={loadSession} />;
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_state_invalid: "Sign-in session expired. Try Google sign-in again.",
  google_not_configured: "Google sign-in is not configured on the server.",
  google_access_denied: "Google sign-in was cancelled.",
  missing_id_token: "Google did not return an ID token.",
  missing_profile: "Google profile was incomplete.",
  token_exchange_failed: "Could not complete Google sign-in.",
  unverified_email: "Your Google email is not verified.",
  hosted_domain_mismatch: "Hosted domain does not match your email.",
  unknown_domain: "Your email domain is not allowed for this admin console.",
  tenant_not_found: "Your tenant is not set up yet. Contact an administrator."
};

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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("error");
    if (code) {
      setError(OAUTH_ERROR_MESSAGES[code] ?? `Sign-in error: ${code}`);
      params.delete("error");
      const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
      window.history.replaceState({}, "", next);
    }
  }, []);

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
          <h1 className="hero-title">Sign in</h1>
          <p className="text-sm mt-2 mb-4" style={{ color: "var(--semantic-text-body)" }}>
            Secure, session-based admin access for tenant operations and channel routing.
          </p>
          {!session.loginEnabled ? (
            <div className="banner error">
              No browser login is configured. Set Google OAuth (ADMIN_AUTH_GOOGLE_ENABLED and related vars) and/or
              ADMIN_PASSWORD_HASH / ADMIN_BASIC_PASSWORD.
            </div>
          ) : null}
          {session.googleLoginEnabled ? (
            <div className="stack">
              <a className="google-signin-button" href="/api/admin/auth/google/start">
                <span className="google-signin-button__icon" aria-hidden="true">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                </span>
                <span className="google-signin-button__label">Sign in with Google</span>
              </a>
              {session.passwordLoginEnabled ? <p className="muted login-divider">or use a password (superadmin)</p> : null}
            </div>
          ) : null}
          {error ? <div className="banner error">{error}</div> : null}
          {session.passwordLoginEnabled ? (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-username" style={{ color: "var(--semantic-text-body)" }}>Username</Label>
                <Input
                  id="login-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-password" style={{ color: "var(--semantic-text-body)" }}>Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <Button type="submit" disabled={submitting} className="w-full mt-2">
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          ) : null}
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
  const isSuperadmin = session.role !== "tenant_admin";
  const [notification, setNotification] = useState<NotificationState | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);

  const notify = useCallback((next: NotificationState | null) => {
    setNotification(next);
  }, []);

  const updateScrollProgress = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    setScrollProgress(maxScroll > 0 ? el.scrollTop / maxScroll : 0);
  }, []);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    updateScrollProgress();
    el.addEventListener("scroll", updateScrollProgress, { passive: true });
    const ro = new ResizeObserver(updateScrollProgress);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollProgress);
      ro.disconnect();
    };
  }, [updateScrollProgress]);

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
        <a href="#admin-main" className="skip-link">
          Skip to main content
        </a>
        <AppSidebar
          username={session.email ?? session.username}
          method={session.authProvider === "google" ? "google" : session.method}
          isSuperadmin={isSuperadmin}
          onLogout={() => void handleLogout()}
        />
        <SidebarInset>
          <header className="content-header">
            <div className="content-header-bar">
              <SidebarTrigger />
            </div>
            <div
              className="scroll-progress"
              style={{ transform: `scaleX(${scrollProgress})` }}
              aria-hidden
            />
          </header>
          <main ref={contentRef} id="admin-main" className="content" tabIndex={-1}>
            {notification ? <div className={`banner ${notification.type}`}>{notification.text}</div> : null}
            <Routes>
              <Route path="/" element={<OverviewPage notify={notify} />} />
              <Route
                path="/new-tenant"
                element={
                  isSuperadmin ? <NewTenantPage notify={notify} /> : <Navigate to="/tenants" replace />
                }
              />
              <Route
                path="/tenants"
                element={
                  <TenantsPage notify={notify} isSuperadmin={isSuperadmin} scopedTenantId={session.scopedTenantId} />
                }
              />
              <Route
                path="/conversations"
                element={<ConversationsPage notify={notify} scopedTenantId={session.scopedTenantId} />}
              />
              <Route
                path="/schedules"
                element={<SchedulesPage notify={notify} scopedTenantId={session.scopedTenantId} isSuperadmin={isSuperadmin} />}
              />
              <Route path="/slack-bot" element={<Navigate to="/" replace />} />
              <Route path="/telegram-bot" element={<Navigate to="/telegram-routing" replace />} />
              <Route
                path="/telegram-routing"
                element={<TelegramRoutingPage notify={notify} scopedTenantId={session.scopedTenantId} />}
              />
              <Route
                path="/settings"
                element={isSuperadmin ? <SettingsPage notify={notify} /> : <Navigate to="/" replace />}
              />
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
      <div className="min-w-0">
        <span className="eyebrow">Admin panel</span>
        <h2 className="mt-1.5 mb-1">{title}</h2>
        <p className="text-sm leading-relaxed" style={{ color: "var(--semantic-text-body)" }}>{subtitle}</p>
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
  const [telegramMappings, setTelegramMappings] = useState<TelegramMapping[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTenants, nextMappings, nextConversations, nextTelegramMappings] = await Promise.all([
        apiRequest<TenantRecord[]>("/api/admin/tenants"),
        apiRequest<SlackMappingsResponse>("/api/admin/slack-mappings"),
        apiRequest<ConversationSummary[]>("/api/admin/conversations?limit=6"),
        apiRequest<TelegramMapping[]>("/api/admin/telegram-mappings")
      ]);
      setTenants(nextTenants);
      setMappings(nextMappings);
      setConversations(nextConversations);
      setTelegramMappings(nextTelegramMappings);
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
        subtitle="Tenants, Slack and Telegram routing, and recent conversations. Run Slack and Telegram worker processes via Docker Compose."
        actions={
          <Button variant="outline" onClick={() => void loadOverview()}>
            Refresh
          </Button>
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
          label="Telegram chats"
          value={loading ? "…" : String(telegramMappings.length)}
          hint="Chat-to-tenant routes"
        />
        <StatCard
          label="Recent conversations"
          value={String(conversations.length)}
          hint="Latest tracked execution threads"
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

        <AppShellCard
          title="Telegram routing"
          subtitle="Chat IDs mapped to tenants (bots run in Compose; manage mappings here or on the Telegram routing page)."
        >
          {loading ? (
            <div className="muted">Loading…</div>
          ) : telegramMappings.length === 0 ? (
            <div className="empty-state">No Telegram chat mappings yet.</div>
          ) : (
            <div className="list-stack">
              {telegramMappings.slice(0, 6).map((m) => (
                <div key={m.chatId} className="list-row">
                  <div>
                    <strong>{m.chatId}</strong>
                    <div className="muted">
                      {m.tenantId}
                      {m.source ? ` · ${m.source}` : ""} · {formatDate(m.updatedAt)}
                    </div>
                  </div>
                </div>
              ))}
              {telegramMappings.length > 6 ? (
                <p className="muted">
                  <Link className="nav-link" to="/telegram-routing">
                    View all {telegramMappings.length} mappings →
                  </Link>
                </p>
              ) : (
                <p className="muted">
                  <Link className="nav-link" to="/telegram-routing">
                    Manage mappings →
                  </Link>
                </p>
              )}
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
    <div className={`bp-card p-6 ${tone ?? ""}`.trim()}>
      <p className="text-xs text-[var(--semantic-text-body)] mb-1">{label}</p>
      <strong className="block text-2xl font-semibold text-[var(--semantic-text-strong)]">{value}</strong>
      <p className="text-xs text-[var(--semantic-text-body)] mt-1">{hint}</p>
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
  const [wizSlackBotToken, setWizSlackBotToken] = useState("");
  const [wizSlackSigningSecret, setWizSlackSigningSecret] = useState("");
  const [wizTelegramBotToken, setWizTelegramBotToken] = useState("");

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
              <Input value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="acme" />
            </label>
            <label>
              Repo URL
              <Input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="git@github.com:org/dbt.git" />
            </label>
            <label>
              dbt subpath
              <Input value={dbtSubpath} onChange={(event) => setDbtSubpath(event.target.value)} />
            </label>
          </div>
          <Button
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
          </Button>
          {results.init ? <JsonBlock value={results.init} /> : null}
        </AppShellCard>

        <AppShellCard title="2. Verify repo access" subtitle="Confirm the deploy key works after you add it on GitHub">
          <Button disabled={!wizardTenantId} onClick={() => wizardTenantId && void runStep("repo_verify", () => apiRequest(`/api/admin/wizard/tenant/${wizardTenantId}/repo-verify`, { method: "POST" }))}>
            Verify repo
          </Button>
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
                  <Input value={account} onChange={(event) => setAccount(event.target.value)} />
                </label>
                <label>
                  Username
                  <Input value={username} onChange={(event) => setUsername(event.target.value)} />
                </label>
                <label>
                  Warehouse
                  <Input value={warehouse} onChange={(event) => setWarehouse(event.target.value)} />
                </label>
                <label>
                  Database
                  <Input value={database} onChange={(event) => setDatabase(event.target.value)} />
                </label>
                <label>
                  Schema
                  <Input value={schema} onChange={(event) => setSchema(event.target.value)} />
                </label>
                <label>
                  Role
                  <Input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Optional" />
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
                    <Input value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} placeholder="/path/to/key.p8" />
                  </label>
                ) : (
                  <label>
                    Password env var
                    <Input value={passwordEnvVar} onChange={(event) => setPasswordEnvVar(event.target.value)} />
                  </label>
                )}
              </>
            ) : (
              <>
                <label>
                  Project ID
                  <Input value={bqProjectId} onChange={(event) => setBqProjectId(event.target.value)} placeholder="my-gcp-project" />
                </label>
                <label>
                  Dataset
                  <Input value={bqDataset} onChange={(event) => setBqDataset(event.target.value)} placeholder="Optional" />
                </label>
                <label>
                  Location
                  <Input value={bqLocation} onChange={(event) => setBqLocation(event.target.value)} placeholder="Optional (e.g. US, EU)" />
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
                    <Input
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
          <Button
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
          </Button>
          {results.warehouse ? <JsonBlock value={results.warehouse} /> : null}
        </AppShellCard>

        <AppShellCard title="4. Test warehouse" subtitle="Run a lightweight connection check">
          <Button disabled={!wizardTenantId} onClick={() => wizardTenantId && void runStep("warehouse_test", () => apiRequest(`/api/admin/wizard/tenant/${wizardTenantId}/warehouse-test`, { method: "POST" }))}>
            Test connectivity
          </Button>
          {results.warehouse_test ? <JsonBlock value={results.warehouse_test} /> : null}
        </AppShellCard>

        <AppShellCard title="5. Slack mappings" subtitle="Add the Slack contexts that should resolve to this tenant">
          <div className="chip-composer">
            <Input value={channelInput} onChange={(event) => setChannelInput(event.target.value)} placeholder="Channel ID" />
            <Button variant="outline" onClick={() => channelInput && (setChannels((current) => [...current, channelInput]), setChannelInput(""))}>
              Add channel
            </Button>
            <Input value={userInput} onChange={(event) => setUserInput(event.target.value)} placeholder="User ID" />
            <Button variant="outline" onClick={() => userInput && (setUsers((current) => [...current, userInput]), setUserInput(""))}>
              Add user
            </Button>
            <Input value={teamInput} onChange={(event) => setTeamInput(event.target.value)} placeholder="Shared team ID" />
            <Button variant="outline" onClick={() => teamInput && (setSharedTeams((current) => [...current, teamInput]), setTeamInput(""))}>
              Add team
            </Button>
          </div>
          <div className="tag-row">
            {channels.map((entry) => <span key={entry} className="tag">{entry}</span>)}
            {users.map((entry) => <span key={entry} className="tag">{entry}</span>)}
            {sharedTeams.map((entry) => <span key={entry} className="tag">{entry}</span>)}
          </div>
          <Button
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
          </Button>
          {results.slack_mappings ? <JsonBlock value={results.slack_mappings} /> : null}
        </AppShellCard>

        <AppShellCard
          title="6. Optional: per-tenant Slack / Telegram bots"
          subtitle="Use a dedicated Slack app per tenant (Request URL includes tenant id) or a dedicated Telegram bot token."
        >
          {wizardTenantId ? (
            <p className="muted">
              Slack Events <strong>Request URL</strong> path suffix:{" "}
              <code>{`/slack/events/tenants/${encodeURIComponent(wizardTenantId)}`}</code>
              <br />
              Append that to your public base URL (same host/port as the Slack process). Tokens are stored server-side and are never shown again after save.
            </p>
          ) : (
            <p className="muted">Initialize the tenant first to see the Slack Request URL path.</p>
          )}
          <div className="form-grid">
            <label>
              Slack bot token (xoxb-…)
              <Input
                type="password"
                autoComplete="off"
                value={wizSlackBotToken}
                onChange={(event) => setWizSlackBotToken(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label>
              Slack signing secret
              <Input
                type="password"
                autoComplete="off"
                value={wizSlackSigningSecret}
                onChange={(event) => setWizSlackSigningSecret(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label>
              Telegram bot token
              <Input
                type="password"
                autoComplete="off"
                value={wizTelegramBotToken}
                onChange={(event) => setWizTelegramBotToken(event.target.value)}
                placeholder="Optional"
              />
            </label>
          </div>
          <Button
            disabled={!wizardTenantId}
            onClick={() =>
              wizardTenantId &&
              void runStep("channel_bots", async () => {
                const body: Record<string, unknown> = {};
                const st = wizSlackBotToken.trim();
                const ss = wizSlackSigningSecret.trim();
                const tg = wizTelegramBotToken.trim();
                if (st && ss) {
                  body.slackBotToken = st;
                  body.slackSigningSecret = ss;
                } else if (st || ss) {
                  throw new Error("Provide both Slack bot token and signing secret, or leave both empty.");
                }
                if (tg) {
                  body.telegramBotToken = tg;
                }
                if (Object.keys(body).length === 0) {
                  return { skipped: true, message: "No channel bot fields filled; nothing saved." };
                }
                const result = await apiRequest<{ ok: boolean }>(`/api/admin/tenants/${wizardTenantId}/channel-bots`, {
                  method: "PATCH",
                  body
                });
                setWizSlackBotToken("");
                setWizSlackSigningSecret("");
                setWizTelegramBotToken("");
                return result;
              })
            }
          >
            Save channel bot credentials
          </Button>
          {results.channel_bots ? <JsonBlock value={results.channel_bots} /> : null}
        </AppShellCard>

        <AppShellCard title="7. Final validation" subtitle="Run the final go-live checks">
          <Button disabled={!wizardTenantId} onClick={() => wizardTenantId && void runStep("final_validate", () => apiRequest(`/api/admin/wizard/tenant/${wizardTenantId}/final-validate`, { method: "POST" }))}>
            Run final checks
          </Button>
          {results.final_validate ? <JsonBlock value={results.final_validate} /> : null}
        </AppShellCard>
      </div>
    </div>
  );
}

function TenantsPage({
  notify,
  isSuperadmin = true,
  scopedTenantId
}: {
  notify: (value: NotificationState | null) => void;
  isSuperadmin?: boolean;
  scopedTenantId?: string;
}): ReactElement {
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
  const [refreshingRepo, setRefreshingRepo] = useState(false);
  const [lastRepoRefresh, setLastRepoRefresh] = useState<{ message: string; refreshedAt?: string } | null>(null);
  const [whProvider, setWhProvider] = useState<"snowflake" | "bigquery">("snowflake");
  const [whSnowflake, setWhSnowflake] = useState({ account: "", username: "", warehouse: "", database: "", schema: "", role: "", authType: "keypair" as "keypair" | "password", privateKeyPath: "", passwordEnvVar: "SNOWFLAKE_PASSWORD" });
  const [whBigQuery, setWhBigQuery] = useState({ projectId: "", dataset: "", location: "", authType: "adc" as "adc" | "service-account-key" });
  const [whEditing, setWhEditing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bqFileInputRef = useRef<HTMLInputElement | null>(null);
  const [loginDomainsDraft, setLoginDomainsDraft] = useState("");
  const [savingLoginDomains, setSavingLoginDomains] = useState(false);
  const [chSlackBotToken, setChSlackBotToken] = useState("");
  const [chSlackSigningSecret, setChSlackSigningSecret] = useState("");
  const [chTelegramBotToken, setChTelegramBotToken] = useState("");
  const [savingChannelBots, setSavingChannelBots] = useState(false);

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
    if (!isSuperadmin && scopedTenantId) {
      setSelectedTenantId(scopedTenantId);
    }
  }, [isSuperadmin, scopedTenantId]);

  useEffect(() => {
    if (!selectedTenantId || !isSuperadmin) {
      setLoginDomainsDraft("");
      return;
    }
    void (async () => {
      try {
        const r = await apiRequest<{ domains: string[] }>(
          `/api/admin/tenants/${selectedTenantId}/admin-login-domains`
        );
        setLoginDomainsDraft(r.domains.join("\n"));
      } catch {
        setLoginDomainsDraft("");
      }
    })();
  }, [selectedTenantId, isSuperadmin]);

  useEffect(() => {
    setLastRepoRefresh(null);
    setChSlackBotToken("");
    setChSlackSigningSecret("");
    setChTelegramBotToken("");
  }, [selectedTenantId]);

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
    if (!selectedTenant && !isSuperadmin) {
      return;
    }
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
    setRefreshingRepo(true);
    try {
      const result = await apiRequest<{ message: string; refreshedAt?: string }>(
        `/api/admin/tenants/${selectedTenant.tenantId}/repo-refresh`,
        {
          method: "POST"
        }
      );
      setLastRepoRefresh({
        message: result.message,
        refreshedAt: result.refreshedAt
      });
      notify({ type: "success", text: result.message });
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setRefreshingRepo(false);
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

  async function saveChannelBots() {
    if (!selectedTenant) return;
    const st = chSlackBotToken.trim();
    const ss = chSlackSigningSecret.trim();
    const tg = chTelegramBotToken.trim();
    if (st && !ss) {
      notify({ type: "error", text: "Provide both Slack bot token and signing secret." });
      return;
    }
    if (!st && ss) {
      notify({ type: "error", text: "Provide both Slack bot token and signing secret." });
      return;
    }
    if (!st && !ss && !tg) {
      notify({ type: "error", text: "Enter new credentials to save, or use Clear Slack / Clear Telegram." });
      return;
    }
    setSavingChannelBots(true);
    try {
      const body: Record<string, unknown> = {};
      if (st && ss) {
        body.slackBotToken = st;
        body.slackSigningSecret = ss;
      }
      if (tg) {
        body.telegramBotToken = tg;
      }
      await apiRequest(`/api/admin/tenants/${selectedTenant.tenantId}/channel-bots`, {
        method: "PATCH",
        body
      });
      setChSlackBotToken("");
      setChSlackSigningSecret("");
      setChTelegramBotToken("");
      notify({ type: "success", text: "Channel bot credentials saved." });
      const [nextWizard, nextTenants] = await Promise.all([
        apiRequest<WizardStateResponse>(`/api/admin/wizard/tenant/${selectedTenant.tenantId}/state`),
        apiRequest<TenantRecord[]>("/api/admin/tenants")
      ]);
      setWizardState(nextWizard);
      setTenants(nextTenants);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setSavingChannelBots(false);
    }
  }

  async function clearChannelSlack() {
    if (!selectedTenant) return;
    setSavingChannelBots(true);
    try {
      await apiRequest(`/api/admin/tenants/${selectedTenant.tenantId}/channel-bots`, {
        method: "PATCH",
        body: { clearSlack: true }
      });
      notify({ type: "success", text: "Slack app credentials cleared for this tenant." });
      const [nextWizard, nextTenants] = await Promise.all([
        apiRequest<WizardStateResponse>(`/api/admin/wizard/tenant/${selectedTenant.tenantId}/state`),
        apiRequest<TenantRecord[]>("/api/admin/tenants")
      ]);
      setWizardState(nextWizard);
      setTenants(nextTenants);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setSavingChannelBots(false);
    }
  }

  async function clearChannelTelegram() {
    if (!selectedTenant) return;
    setSavingChannelBots(true);
    try {
      await apiRequest(`/api/admin/tenants/${selectedTenant.tenantId}/channel-bots`, {
        method: "PATCH",
        body: { clearTelegram: true }
      });
      notify({ type: "success", text: "Telegram bot token cleared for this tenant." });
      const [nextWizard, nextTenants] = await Promise.all([
        apiRequest<WizardStateResponse>(`/api/admin/wizard/tenant/${selectedTenant.tenantId}/state`),
        apiRequest<TenantRecord[]>("/api/admin/tenants")
      ]);
      setWizardState(nextWizard);
      setTenants(nextTenants);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setSavingChannelBots(false);
    }
  }

  async function saveLoginDomains() {
    if (!selectedTenant || !isSuperadmin) return;
    const lines = loginDomainsDraft
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    setSavingLoginDomains(true);
    try {
      const r = await apiRequest<{ domains: string[] }>(
        `/api/admin/tenants/${selectedTenant.tenantId}/admin-login-domains`,
        {
          method: "PUT",
          headers: {
            Origin: window.location.origin
          },
          body: { domains: lines }
        }
      );
      setLoginDomainsDraft(r.domains.join("\n"));
      notify({ type: "success", text: "Google login domains updated." });
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setSavingLoginDomains(false);
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
          isSuperadmin ? (
            <Button
              variant="outline"
              onClick={() => {
                setSelectedTenantId(null);
                setForm({ tenantId: "", repoUrl: "", dbtSubpath: "models" });
              }}
            >
              New tenant
            </Button>
          ) : undefined
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
                <Button
                  key={tenant.tenantId}
                  type="button"
                  className={`tenant-list-item ${selectedTenantId === tenant.tenantId ? "selected" : ""}`}
                  onClick={() => {
                    if (!isSuperadmin && scopedTenantId && tenant.tenantId !== scopedTenantId) {
                      return;
                    }
                    setSelectedTenantId(tenant.tenantId);
                  }}
                >
                  <strong>{tenant.tenantId}</strong>
                  <span>{compactText(tenant.repoUrl, 42)}</span>
                </Button>
              ))}
            </div>
          )}
        </AppShellCard>

        <div className="double-stack">
          <AppShellCard
            title={selectedTenant ? `Tenant · ${selectedTenant.tenantId}` : "Create tenant"}
            subtitle="Repo configuration and primary tenant identifiers"
            action={
              <Button onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving…" : selectedTenant ? "Save changes" : "Create tenant"}
              </Button>
            }
          >
            <div className="form-grid">
              <label>
                Tenant ID
                <Input
                  value={form.tenantId}
                  onChange={(event) => setForm((current) => ({ ...current, tenantId: event.target.value }))}
                  disabled={Boolean(selectedTenant)}
                />
              </label>
              <label>
                Repo URL
                <Input value={form.repoUrl} onChange={(event) => setForm((current) => ({ ...current, repoUrl: event.target.value }))} />
              </label>
              <label>
                dbt subpath
                <Input value={form.dbtSubpath} onChange={(event) => setForm((current) => ({ ...current, dbtSubpath: event.target.value }))} />
              </label>
            </div>
            {selectedTenant ? (
              <div className="stack">
                <div className="button-row">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => void refreshRepo()}
                    disabled={refreshingRepo || saving}
                  >
                    {refreshingRepo ? "Refreshing…" : "Refresh repo"}
                  </Button>
                {warehouseConfig?.provider === "snowflake" ? (
                  <>
                    <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                      Upload .p8 key
                    </Button>
                    <Input
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
                    <Button variant="outline" onClick={() => bqFileInputRef.current?.click()}>
                      Upload SA key (.json)
                    </Button>
                    <Input
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
                  {isSuperadmin ? (
                    <Button variant="destructive" onClick={() => void deleteTenant()}>
                      Delete tenant
                    </Button>
                  ) : null}
                </div>
                {lastRepoRefresh ? (
                  <p className="muted">
                    {lastRepoRefresh.message}
                    {lastRepoRefresh.refreshedAt ? ` · ${formatDate(lastRepoRefresh.refreshedAt)}` : ""}
                  </p>
                ) : null}
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
                <DetailItem
                  label="Per-tenant Slack app"
                  value={wizardState?.hasSlackBotOverride ? "Configured" : "Not configured"}
                />
                <DetailItem
                  label="Per-tenant Telegram bot"
                  value={wizardState?.hasTelegramBotOverride ? "Configured" : "Not configured"}
                />
                <DetailItem label="Updated" value={formatDate(selectedTenant.updatedAt)} />
              </div>
            ) : (
              <div className="empty-state">Create or select a tenant to inspect operational state.</div>
            )}
          </AppShellCard>

          {selectedTenant ? (
            <AppShellCard
              title="Per-tenant Slack / Telegram bots"
              subtitle="Optional dedicated Slack app (token + signing secret) or Telegram bot token. Secrets are write-only."
              action={
                <div className="button-row">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={savingChannelBots}
                    onClick={() => void clearChannelSlack()}
                  >
                    Clear Slack
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={savingChannelBots}
                    onClick={() => void clearChannelTelegram()}
                  >
                    Clear Telegram
                  </Button>
                  <Button type="button" disabled={savingChannelBots} onClick={() => void saveChannelBots()}>
                    {savingChannelBots ? "Saving…" : "Save credentials"}
                  </Button>
                </div>
              }
            >
              {wizardState?.slackEventsPathSuffix ? (
                <p className="muted">
                  Slack Request URL path suffix: <code>{wizardState.slackEventsPathSuffix}</code>
                </p>
              ) : null}
              <div className="form-grid">
                <label>
                  Slack bot token
                  <Input
                    type="password"
                    autoComplete="off"
                    value={chSlackBotToken}
                    onChange={(event) => setChSlackBotToken(event.target.value)}
                    placeholder="Paste to set or rotate"
                  />
                </label>
                <label>
                  Slack signing secret
                  <Input
                    type="password"
                    autoComplete="off"
                    value={chSlackSigningSecret}
                    onChange={(event) => setChSlackSigningSecret(event.target.value)}
                    placeholder="Paste to set or rotate"
                  />
                </label>
                <label>
                  Telegram bot token
                  <Input
                    type="password"
                    autoComplete="off"
                    value={chTelegramBotToken}
                    onChange={(event) => setChTelegramBotToken(event.target.value)}
                    placeholder="Paste to set or rotate"
                  />
                </label>
              </div>
            </AppShellCard>
          ) : null}

          {isSuperadmin && selectedTenant ? (
            <AppShellCard
              title="Google admin login domains"
              action={
                <Button
                  type="button"
                  variant="outline"
                  disabled={savingLoginDomains}
                  onClick={() => void saveLoginDomains()}
                >
                  {savingLoginDomains ? "Saving…" : "Save domains"}
                </Button>
              }
            >
              <label>
                Domains (one per line or comma-separated)
                <Textarea
                  rows={4}
                  value={loginDomainsDraft}
                  onChange={(event) => setLoginDomainsDraft(event.target.value)}
                  placeholder="takenos.com"
                />
              </label>
              <p className="muted">Enter the domain only (e.g. example.com), not full email addresses.</p>
            </AppShellCard>
          ) : null}

          <AppShellCard title="Tenant memories" subtitle="View the saved tenant facts that will be available to future conversations.">
            {!selectedTenant ? (
              <div className="empty-state">Select a tenant to manage tenant memories.</div>
            ) : (
              <div className="stack">
                <label>
                  Add manual memory
                  <Textarea
                    rows={3}
                    value={memoryDraft}
                    maxLength={300}
                    onChange={(event) => setMemoryDraft(event.target.value)}
                    placeholder="Example: Revenue means gross revenue unless the user explicitly asks for net revenue."
                  />
                </label>
                <div className="button-row">
                  <Button onClick={() => void addTenantMemory()} disabled={savingMemory || memoryDraft.trim().length === 0}>
                    {savingMemory ? "Adding…" : "Add memory"}
                  </Button>
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
                          <Button
                            variant="destructive" size="sm"
                            onClick={() => void deleteTenantMemory(memory.id)}
                            disabled={deletingMemoryId === memory.id}
                          >
                            {deletingMemoryId === memory.id ? "Deleting…" : "Delete"}
                          </Button>
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
                    <Button onClick={() => void saveWarehouse()} disabled={savingWarehouse}>
                      {savingWarehouse ? "Saving…" : "Save"}
                    </Button>
                    <Button variant="outline" onClick={() => setWhEditing(false)}>Cancel</Button>
                  </div>
                ) : (
                  <Button variant="outline" onClick={() => setWhEditing(true)}>Edit</Button>
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
                      <label>Account<Input value={whSnowflake.account} onChange={(e) => setWhSnowflake((c) => ({ ...c, account: e.target.value }))} /></label>
                      <label>Username<Input value={whSnowflake.username} onChange={(e) => setWhSnowflake((c) => ({ ...c, username: e.target.value }))} /></label>
                      <label>Warehouse<Input value={whSnowflake.warehouse} onChange={(e) => setWhSnowflake((c) => ({ ...c, warehouse: e.target.value }))} /></label>
                      <label>Database<Input value={whSnowflake.database} onChange={(e) => setWhSnowflake((c) => ({ ...c, database: e.target.value }))} /></label>
                      <label>Schema<Input value={whSnowflake.schema} onChange={(e) => setWhSnowflake((c) => ({ ...c, schema: e.target.value }))} /></label>
                      <label>Role<Input value={whSnowflake.role} onChange={(e) => setWhSnowflake((c) => ({ ...c, role: e.target.value }))} placeholder="Optional" /></label>
                      <label>
                        Auth type
                        <select value={whSnowflake.authType} onChange={(e) => setWhSnowflake((c) => ({ ...c, authType: e.target.value as "keypair" | "password" }))}>
                          <option value="keypair">Keypair</option>
                          <option value="password">Password</option>
                        </select>
                      </label>
                      {whSnowflake.authType === "keypair" ? (
                        <label>Private key path<Input value={whSnowflake.privateKeyPath} onChange={(e) => setWhSnowflake((c) => ({ ...c, privateKeyPath: e.target.value }))} placeholder="/path/to/key.p8" /></label>
                      ) : (
                        <label>Password env var<Input value={whSnowflake.passwordEnvVar} onChange={(e) => setWhSnowflake((c) => ({ ...c, passwordEnvVar: e.target.value }))} /></label>
                      )}
                    </>
                  ) : (
                    <>
                      <label>Project ID<Input value={whBigQuery.projectId} onChange={(e) => setWhBigQuery((c) => ({ ...c, projectId: e.target.value }))} placeholder="my-gcp-project" /></label>
                      <label>Dataset<Input value={whBigQuery.dataset} onChange={(e) => setWhBigQuery((c) => ({ ...c, dataset: e.target.value }))} placeholder="Optional" /></label>
                      <label>Location<Input value={whBigQuery.location} onChange={(e) => setWhBigQuery((c) => ({ ...c, location: e.target.value }))} placeholder="Optional (e.g. US, EU)" /></label>
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

function SchedulesPage({
  notify,
  scopedTenantId,
  isSuperadmin = true
}: {
  notify: (value: NotificationState | null) => void;
  scopedTenantId?: string;
  isSuperadmin?: boolean;
}): ReactElement {
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<TenantScheduleRecord[]>([]);
  const [channelOptions, setChannelOptions] = useState<ScheduleChannelOptions | null>(null);
  const [events, setEvents] = useState<SchedulerBotEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    userRequest: "",
    cron: "0 9 * * *",
    channelType: "console" as TenantScheduleRecord["channelType"],
    channelRef: "",
    active: true
  });

  const effectiveTenantId = useMemo(() => {
    if (!isSuperadmin) {
      return scopedTenantId ?? null;
    }
    return selectedTenantId;
  }, [isSuperadmin, scopedTenantId, selectedTenantId]);

  const loadTenants = useCallback(async () => {
    try {
      const next = await apiRequest<TenantRecord[]>("/api/admin/tenants");
      setTenants(next);
      if (!selectedTenantId && next.length > 0) {
        setSelectedTenantId(scopedTenantId ?? next[0].tenantId);
      }
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }, [notify, selectedTenantId, scopedTenantId]);

  const loadSchedules = useCallback(async () => {
    if (!effectiveTenantId) {
      setSchedules([]);
      setChannelOptions(null);
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextSchedules, options, logs] = await Promise.all([
        apiRequest<TenantScheduleRecord[]>(`/api/admin/tenants/${effectiveTenantId}/schedules`),
        apiRequest<ScheduleChannelOptions>(`/api/admin/tenants/${effectiveTenantId}/schedules/channel-options`),
        apiRequest<SchedulerBotEventRecord[]>(`/api/admin/scheduler/events?limit=40&tenantId=${effectiveTenantId}`)
      ]);
      setSchedules(nextSchedules);
      setChannelOptions(options);
      setEvents(logs);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoading(false);
    }
  }, [effectiveTenantId, notify]);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  useEffect(() => {
    if (!isSuperadmin && scopedTenantId) {
      setSelectedTenantId(scopedTenantId);
    }
  }, [isSuperadmin, scopedTenantId]);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const channelOptionsForType = useMemo(() => {
    if (!channelOptions) return [] as Array<{ value: string; label: string }>;
    if (form.channelType === "slack") {
      return channelOptions.slackChannels.map((entry) => ({
        value: entry.channelId,
        label: `${entry.channelId}${entry.source ? ` · ${entry.source}` : ""}`
      }));
    }
    if (form.channelType === "telegram") {
      return channelOptions.telegramChats.map((entry) => ({
        value: entry.chatId,
        label: `${entry.chatId}${entry.source ? ` · ${entry.source}` : ""}`
      }));
    }
    return [] as Array<{ value: string; label: string }>;
  }, [channelOptions, form.channelType]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!effectiveTenantId) return;
    setSaving(true);
    try {
      const payload = {
        userRequest: form.userRequest,
        cron: form.cron,
        channelType: form.channelType,
        channelRef: form.channelRef || undefined,
        active: form.active
      };
      if (editingId) {
        await apiRequest<TenantScheduleRecord>(
          `/api/admin/tenants/${effectiveTenantId}/schedules/${editingId}`,
          { method: "PUT", body: payload }
        );
        notify({ type: "success", text: "Schedule updated." });
      } else {
        await apiRequest<TenantScheduleRecord>(`/api/admin/tenants/${effectiveTenantId}/schedules`, {
          method: "POST",
          body: payload
        });
        notify({ type: "success", text: "Schedule created." });
      }
      setForm({ userRequest: "", cron: "0 9 * * *", channelType: form.channelType, channelRef: "", active: true });
      setEditingId(null);
      await loadSchedules();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(scheduleId: string) {
    if (!effectiveTenantId) return;
    try {
      await apiRequest(`/api/admin/tenants/${effectiveTenantId}/schedules/${scheduleId}`, { method: "DELETE" });
      notify({ type: "success", text: "Schedule deleted." });
      if (editingId === scheduleId) {
        setEditingId(null);
      }
      await loadSchedules();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function handleTestRun(scheduleId: string) {
    if (!effectiveTenantId) return;
    try {
      await apiRequest<{ status: string }>(`/api/admin/tenants/${effectiveTenantId}/schedules/${scheduleId}/test`, {
        method: "POST",
        body: {}
      });
      notify({ type: "info", text: "Test run queued." });
      await loadSchedules();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function refreshChannels() {
    if (!effectiveTenantId) return;
    setLoadingOptions(true);
    try {
      const options = await apiRequest<ScheduleChannelOptions>(
        `/api/admin/tenants/${effectiveTenantId}/schedules/channel-options`
      );
      setChannelOptions(options);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoadingOptions(false);
    }
  }

  return (
    <div className="page-grid">
      <PageHeader
        title="Schedules"
        subtitle="Create recurring prompts per tenant and deliver them to Slack, Telegram, or console channels."
        actions={
          <Button variant="outline" onClick={() => void loadSchedules()}>
            Refresh
          </Button>
        }
      />
      <div className="two-column">
        <AppShellCard
          title="Schedule form"
          subtitle="Create a new schedule or edit an existing one (UTC cron)."
          action={
            <div className="filters-row">
              <select
                disabled={!isSuperadmin}
                value={effectiveTenantId ?? ""}
                onChange={(event) => setSelectedTenantId(event.target.value)}
              >
                <option value="" disabled>
                  Select tenant
                </option>
                {tenants.map((tenant) => (
                  <option key={tenant.tenantId} value={tenant.tenantId}>
                    {tenant.tenantId}
                  </option>
                ))}
              </select>
              <Button variant="outline" onClick={() => void refreshChannels()} disabled={!effectiveTenantId || loadingOptions}>
                Refresh channels
              </Button>
            </div>
          }
        >
          {!effectiveTenantId ? (
            <div className="muted">Choose a tenant to manage schedules.</div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={handleSave}>
              <label>
                User request
                <Textarea
                  required
                  rows={2}
                  value={form.userRequest}
                  onChange={(event) => setForm((current) => ({ ...current, userRequest: event.target.value }))}
                />
              </label>
              <div className="schedule-form-grid">
                <label>
                  Cron (UTC)
                  <Input
                    required
                    value={form.cron}
                    onChange={(event) => setForm((current) => ({ ...current, cron: event.target.value }))}
                  />
                </label>
                <label>
                  Channel type
                  <select
                    value={form.channelType}
                    onChange={(event) => setForm((current) => ({ ...current, channelType: event.target.value as TenantScheduleRecord["channelType"] }))}
                  >
                    <option value="slack">Slack</option>
                    <option value="telegram">Telegram</option>
                    <option value="console">Console</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                <label>
                  Channel reference
                  {channelOptionsForType.length > 0 ? (
                    <select
                      value={form.channelRef}
                      onChange={(event) => setForm((current) => ({ ...current, channelRef: event.target.value }))}
                    >
                      <option value="">Select destination</option>
                      {channelOptionsForType.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      value={form.channelRef}
                      onChange={(event) => setForm((current) => ({ ...current, channelRef: event.target.value }))}
                      placeholder={form.channelType === "console" ? "optional" : "Channel ID or chat ID"}
                    />
                  )}
                </label>
              </div>
              <div className="flex items-center justify-between gap-3">
                <label className="checkbox-row">
                  <Input
                    type="checkbox"
                    checked={form.active}
                    onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))}
                  />
                  Active
                </label>
                <div className="button-row">
                  <Button type="submit" disabled={saving || !form.userRequest.trim()}>
                    {saving ? "Saving…" : editingId ? "Update" : "Create schedule"}
                  </Button>
                  {editingId ? (
                    <Button type="button" variant="outline" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </div>
            </form>
          )}
        </AppShellCard>

        <AppShellCard title="Schedules" subtitle="Active/paused status, last run time, and delivery status">
          {loading ? (
            <div className="muted">Loading…</div>
          ) : schedules.length === 0 ? (
            <div className="empty-state">No schedules yet for this tenant.</div>
          ) : (
            <div className="stack">
              {schedules.map((schedule) => (
                <div key={schedule.id} className="list-row">
                  <div>
                    <strong>{schedule.userRequest}</strong>
                    <div className="muted">
                      {schedule.cron} · {schedule.channelType}
                      {schedule.channelRef ? ` (${schedule.channelRef})` : ""}
                    </div>
                    <div className="muted">
                      Status: {schedule.active ? "active" : "paused"} · Last run: {formatDate(schedule.lastRunAt)} · Error: {schedule.lastError ?? "—"}
                    </div>
                  </div>
                  <div className="button-row">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setEditingId(schedule.id);
                        setForm({
                          userRequest: schedule.userRequest,
                          cron: schedule.cron,
                          channelType: schedule.channelType,
                          channelRef: schedule.channelRef ?? "",
                          active: schedule.active
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button variant="outline" onClick={() => void handleTestRun(schedule.id)}>
                      Test run
                    </Button>
                    <Button variant="destructive" onClick={() => void handleDelete(schedule.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </AppShellCard>
      </div>

      <div className="two-column">
        <AppShellCard title="Action log" subtitle="Recent schedule test triggers (latest first)">
          {events.length === 0 ? (
            <div className="empty-state">No test triggers yet.</div>
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
        <AppShellCard title="Channel options" subtitle="Mapped Slack channels and Telegram chats for this tenant">
          {loadingOptions ? (
            <div className="muted">Loading…</div>
          ) : !channelOptions ? (
            <div className="muted">Refresh to load channel options.</div>
          ) : (
            <div className="details-grid">
              <DetailItem label="Slack channels" value={channelOptions.slackChannels.map((c) => c.channelId).join(", ") || "—"} multiline />
              <DetailItem label="Telegram chats" value={channelOptions.telegramChats.map((c) => c.chatId).join(", ") || "—"} multiline />
            </div>
          )}
        </AppShellCard>
      </div>
    </div>
  );
}

function ConversationsPage({
  notify,
  scopedTenantId
}: {
  notify: (value: NotificationState | null) => void;
  scopedTenantId?: string;
}): ReactElement {
  const [filters, setFilters] = useState({ tenantId: "", source: "", search: "" });
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (scopedTenantId) {
      setFilters((current) => ({ ...current, tenantId: scopedTenantId }));
    }
  }, [scopedTenantId]);

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const tenantForQuery = scopedTenantId ?? filters.tenantId;
      if (tenantForQuery) params.set("tenantId", tenantForQuery);
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
  }, [filters.tenantId, filters.source, filters.search, notify, scopedTenantId, selectedId]);

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

      {/* Filters bar — compact inline */}
      <div className="conv-filters">
        {scopedTenantId ? (
          <span className="muted text-sm">Tenant: <strong>{scopedTenantId}</strong></span>
        ) : (
          <Input
            placeholder="Tenant ID"
            value={filters.tenantId}
            onChange={(event) => setFilters((current) => ({ ...current, tenantId: event.target.value }))}
          />
        )}
        <select
          value={filters.source}
          onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))}
        >
          <option value="">All sources</option>
          <option value="cli">CLI</option>
          <option value="slack">Slack</option>
          <option value="admin">Admin</option>
        </select>
        <Input
          placeholder="Search messages…"
          value={filters.search}
          onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
        />
        <Button variant="outline" size="sm" onClick={() => void loadConversations()}>
          Apply
        </Button>
      </div>

      {/* Main split layout */}
      <div className="conv-layout">
        {/* Left: conversation list */}
        <div className="conv-list-panel bp-card">
          <div className="conv-panel-header">
            <span className="conv-panel-title">Threads</span>
            <span className="conv-panel-count">{items.length}</span>
          </div>
          {loading ? (
            <div className="conv-empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="conv-empty">No conversations match your filters.</div>
          ) : (
            <div className="conv-list">
              {items.map((item) => (
                <button
                  key={item.conversationId}
                  className={`conv-item${selectedId === item.conversationId ? " conv-item--active" : ""}`}
                  onClick={() => setSelectedId(item.conversationId)}
                >
                  <div className="conv-item__header">
                    <span className="conv-item__tenant">{item.tenantId}</span>
                    {item.latestTurnStatus ? (
                      <StatusBadge
                        label={item.latestTurnStatus}
                        tone={item.latestTurnStatus === "completed" ? "success" : item.latestTurnStatus === "failed" ? "error" : "warning"}
                      />
                    ) : null}
                  </div>
                  {item.latestUserText ? (
                    <p className="conv-item__text">{compactText(item.latestUserText, 80)}</p>
                  ) : null}
                  <span className="conv-item__date">{formatDate(item.lastMessageAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: detail panels */}
        <div className="conv-detail-col">
          {/* Metadata + messages */}
          <div className="bp-card">
            <div className="conv-panel-header">
              <span className="conv-panel-title">Messages</span>
              {detail ? (
                <div className="flex items-center gap-2">
                  <span className="conv-meta-chip">{detail.summary.tenantId}</span>
                  {detail.summary.source ? <span className="conv-meta-chip">{detail.summary.source}</span> : null}
                </div>
              ) : null}
            </div>
            {!detail ? (
              <div className="conv-empty">Select a conversation to inspect.</div>
            ) : (
              <>
                {/* Compact metadata row */}
                <div className="conv-meta-row">
                  {detail.summary.channelId ? (
                    <div className="conv-meta-item"><span>Channel</span><strong>{detail.summary.channelId}</strong></div>
                  ) : null}
                  {detail.summary.threadTs ? (
                    <div className="conv-meta-item"><span>Thread</span><strong>{detail.summary.threadTs}</strong></div>
                  ) : null}
                  <div className="conv-meta-item"><span>Messages</span><strong>{detail.messages.length}</strong></div>
                  <div className="conv-meta-item"><span>Last active</span><strong>{formatDate(detail.summary.lastMessageAt)}</strong></div>
                </div>

                {/* Message timeline */}
                <div className="conv-messages">
                  {detail.messages.map((message) => (
                    <div key={message.id} className={`conv-bubble conv-bubble--${message.role}`}>
                      <div className="conv-bubble__meta">
                        <span className="conv-bubble__role">{message.role}</span>
                        <span className="conv-bubble__time">{formatDate(message.createdAt)}</span>
                      </div>
                      <div className="conv-bubble__body">{message.content}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Execution turns */}
          <div className="bp-card">
            <div className="conv-panel-header">
              <span className="conv-panel-title">Execution turns</span>
              {detail ? <span className="conv-panel-count">{detail.executionTurns.length}</span> : null}
            </div>
            {!detail ? (
              <div className="conv-empty">Choose a conversation to see execution details.</div>
            ) : detail.executionTurns.length === 0 ? (
              <div className="conv-empty">No execution turns recorded.</div>
            ) : (
              <div className="conv-turns">
                {detail.executionTurns.map((turn) => (
                  <details key={turn.id} className="conv-turn">
                    <summary className="conv-turn__header">
                      <div className="conv-turn__meta">
                        <code className="conv-turn__id">{turn.id.slice(0, 8)}…</code>
                        <span className="conv-turn__date">{formatDate(turn.createdAt)}</span>
                      </div>
                      <StatusBadge
                        label={turn.status}
                        tone={turn.status === "completed" ? "success" : turn.status === "failed" ? "error" : "warning"}
                      />
                    </summary>
                    <div className="conv-turn__body">
                      {turn.rawUserText ? (
                        <div className="conv-turn__field">
                          <span className="conv-turn__label">User</span>
                          <p className="conv-turn__value">{compactText(turn.rawUserText, 200)}</p>
                        </div>
                      ) : null}
                      {turn.assistantText ? (
                        <div className="conv-turn__field">
                          <span className="conv-turn__label">Assistant</span>
                          <p className="conv-turn__value">{compactText(turn.assistantText, 200)}</p>
                        </div>
                      ) : null}
                      {turn.errorMessage ? (
                        <div className="conv-turn__field conv-turn__field--error">
                          <span className="conv-turn__label">Error</span>
                          <p className="conv-turn__value">{turn.errorMessage}</p>
                        </div>
                      ) : null}
                      {turn.debug ? <JsonBlock value={turn.debug} /> : null}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TelegramRoutingPage({
  notify,
  scopedTenantId
}: {
  notify: (value: NotificationState | null) => void;
  scopedTenantId?: string;
}): ReactElement {
  const [mappings, setMappings] = useState<TelegramMapping[]>([]);
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [chatId, setChatId] = useState("");
  const [tenantId, setTenantId] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [nextMappings, nextTenants] = await Promise.all([
        apiRequest<TelegramMapping[]>("/api/admin/telegram-mappings"),
        apiRequest<TenantRecord[]>("/api/admin/tenants")
      ]);
      setMappings(nextMappings);
      setTenants(nextTenants);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (scopedTenantId) {
      setTenantId(scopedTenantId);
    }
  }, [scopedTenantId]);

  async function addMapping() {
    if (!chatId || !tenantId) return;
    try {
      await apiRequest(`/api/admin/telegram-mappings/${chatId}`, {
        method: "PUT",
        headers: {
          Origin: window.location.origin
        },
        body: { tenantId }
      });
      notify({ type: "success", text: `Mapped chat ${chatId} to tenant ${tenantId}.` });
      setChatId("");
      setTenantId(scopedTenantId ?? "");
      await loadData();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function deleteMapping(id: string) {
    try {
      await apiRequest(`/api/admin/telegram-mappings/${id}`, {
        method: "DELETE",
        headers: {
          Origin: window.location.origin
        }
      });
      notify({ type: "success", text: "Mapping deleted." });
      await loadData();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  return (
    <div className="page-grid">
      <PageHeader
        title="Telegram routing"
        subtitle="Map Telegram chat IDs to tenants. Run the Telegram worker with Docker Compose; avoid starting a second bot process elsewhere."
        actions={
          <Button variant="outline" onClick={() => void loadData()}>
            Refresh
          </Button>
        }
      />
      <div className="two-column">
        <AppShellCard title="Chat-to-tenant mappings" subtitle="Route Telegram chats to specific tenants">
          <div className="filters-row">
            <Input placeholder="Chat ID" value={chatId} onChange={(event) => setChatId(event.target.value)} />
            {scopedTenantId ? (
              <span className="muted">Tenant: {scopedTenantId}</span>
            ) : (
              <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
                <option value="">Select tenant…</option>
                {tenants.map((tenant) => (
                  <option key={tenant.tenantId} value={tenant.tenantId}>
                    {tenant.tenantId}
                  </option>
                ))}
              </select>
            )}
            <Button variant="outline" onClick={() => void addMapping()} disabled={!chatId || !tenantId}>
              Add mapping
            </Button>
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
                  <Button variant="destructive" size="sm" onClick={() => void deleteMapping(mapping.chatId)}>
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </AppShellCard>

        <AppShellCard title="Configuration reference" subtitle="Set these on the Telegram Compose service (or host) for the worker process">
          <div className="config-ref-list">
            <ConfigRefItem name="TELEGRAM_BOT_TOKEN" desc="Bot token from @BotFather (required)" />
            <ConfigRefItem name="TELEGRAM_DEFAULT_TENANT_ID" desc="Fallback tenant for unmapped chats (optional)" />
            <ConfigRefItem name="TELEGRAM_DEFAULT_PROFILE_NAME" desc="Agent profile name (default: 'default')" />
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
      <PageHeader title="Settings" subtitle="Slack routing defaults, guardrails, and mapping management. Run the Slack Events worker via Docker Compose." />
      <div className="two-column">
        <AppShellCard title="Guardrails" subtitle="Owner defaults, strict routing, and workspace fallback map">
          {!guardrails ? (
            <div className="muted">Loading…</div>
          ) : (
            <form className="stack" onSubmit={saveGuardrails}>
              <label>
                Default tenant ID
                <Input value={guardrails.defaultTenantId ?? ""} onChange={(event) => setGuardrails((current) => current ? { ...current, defaultTenantId: event.target.value } : current)} />
              </label>
              <label>
                Owner team IDs
                <Input
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
                <Input
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
                <Input
                  type="checkbox"
                  checked={guardrails.strictTenantRouting}
                  onChange={(event) => setGuardrails((current) => current ? { ...current, strictTenantRouting: event.target.checked } : current)}
                />
                Strict tenant routing
              </label>
              <label>
                Team → tenant map (JSON)
                <Textarea
                  rows={8}
                  value={teamTenantMapText}
                  onChange={(event) => setTeamTenantMapText(event.target.value)}
                />
              </label>
              <Button type="submit">Save guardrails</Button>
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
      <Input placeholder={`${label} ID`} value={idValue} onChange={(event) => onIdChange(event.target.value)} />
      <Input placeholder="Tenant ID" value={tenantValue} onChange={(event) => onTenantChange(event.target.value)} />
      <Button variant="outline" onClick={onSave}>
        Save {label.toLowerCase()}
      </Button>
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
            <Button variant="destructive" size="sm" onClick={() => onDelete(item.id)}>
              Delete
            </Button>
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

function ConfigRefItem({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="config-ref-item">
      <code className="config-ref-name">{name}</code>
      <span className="config-ref-desc">{desc}</span>
    </div>
  );
}

export default App;
