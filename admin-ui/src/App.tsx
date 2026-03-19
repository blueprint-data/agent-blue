import type { FormEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { apiRequest } from "./api";
import { AppSidebar } from "./components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";
import { sectionError } from "./lib/admin";
import { ConversationsPage } from "./pages/conversations-page";
import { NewTenantPage } from "./pages/new-tenant-page";
import { OverviewPage } from "./pages/overview-page";
import { SettingsPage } from "./pages/settings-page";
import { SlackBotPage } from "./pages/slack-bot-page";
import { TenantsPage } from "./pages/tenants-page";
import type { NotificationState, SessionState } from "./types/admin";

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
            <div className="banner error">
              Browser login is not configured. Set ADMIN_PASSWORD_HASH or ADMIN_BASIC_PASSWORD.
            </div>
          ) : null}
          <form onSubmit={handleSubmit} className="stack">
            <label>
              Username
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
              />
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
              <Route path="/settings" element={<SettingsPage notify={notify} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}

export default App;
