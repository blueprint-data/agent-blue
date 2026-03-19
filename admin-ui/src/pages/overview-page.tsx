import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../api";
import { AppShellCard, PageHeader, StatCard, StatusBadge } from "../components/admin/common";
import { compactText, formatDate, sectionError } from "../lib/admin";
import type {
  BotEvent,
  BotStatus,
  ConversationSummary,
  NotifyFn,
  SlackMappingsResponse,
  TenantRecord
} from "../types/admin";

export function OverviewPage({ notify }: { notify: NotifyFn }): ReactElement {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [mappings, setMappings] = useState<SlackMappingsResponse | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [botStatus, setBotStatus] = useState<BotStatus | null>(null);
  const [botEvents, setBotEvents] = useState<BotEvent[]>([]);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTenants, nextMappings, nextConversations, nextBotStatus, nextBotEvents] =
        await Promise.all([
          apiRequest<TenantRecord[]>("/api/admin/tenants"),
          apiRequest<SlackMappingsResponse>("/api/admin/slack-mappings"),
          apiRequest<ConversationSummary[]>("/api/admin/conversations?limit=6"),
          apiRequest<BotStatus>("/api/admin/bot/status"),
          apiRequest<BotEvent[]>("/api/admin/bot/events?limit=5")
        ]);
      setTenants(nextTenants);
      setMappings(nextMappings);
      setConversations(nextConversations);
      setBotStatus(nextBotStatus);
      setBotEvents(nextBotEvents);
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
          tone={
            botStatus?.actualState === "running"
              ? "success"
              : botStatus?.actualState === "error"
                ? "error"
                : "neutral"
          }
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
                    <StatusBadge
                      label={event.level}
                      tone={
                        event.level === "error"
                          ? "error"
                          : event.level === "warn"
                            ? "warning"
                            : "success"
                      }
                    />
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
