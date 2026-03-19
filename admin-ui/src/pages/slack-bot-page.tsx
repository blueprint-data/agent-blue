import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../api";
import { AppShellCard, DetailItem, PageHeader, StatusBadge } from "../components/admin/common";
import { JsonBlock } from "../components/admin/json-block";
import { formatDate, sectionError } from "../lib/admin";
import type { BotEvent, BotStatus, NotifyFn } from "../types/admin";

export function SlackBotPage({ notify }: { notify: NotifyFn }): ReactElement {
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
        <AppShellCard
          title="Bot status"
          subtitle="Current desired/actual runtime state and recent lifecycle timestamps"
        >
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

        <AppShellCard
          title="Recent bot events"
          subtitle="Lifecycle and processing events emitted by the embedded supervisor"
        >
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
