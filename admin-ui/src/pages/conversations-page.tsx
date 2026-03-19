import type { ReactElement } from "react";
import { AppShellCard, DetailItem, PageHeader, StatusBadge } from "../components/admin/common";
import { JsonBlock } from "../components/admin/json-block";
import { useConversationsData } from "../hooks/use-conversations-data";
import { compactText, formatDate } from "../lib/admin";
import type { NotifyFn } from "../types/admin";

export function ConversationsPage({ notify }: { notify: NotifyFn }): ReactElement {
  const { filters, items, selectedId, detail, loading, setFilters, setSelectedId, loadConversations } =
    useConversationsData(notify);

  return (
    <div className="page-grid">
      <PageHeader
        title="Conversations"
        subtitle="Inspect raw messages, execution turns, SQL/debug traces, and Slack origin metadata."
      />
      <AppShellCard title="Filters" subtitle="Slice by tenant, source, or message text">
        <div className="filters-row">
          <input
            placeholder="Tenant ID"
            value={filters.tenantId}
            onChange={(event) =>
              setFilters((current) => ({ ...current, tenantId: event.target.value }))
            }
          />
          <select
            value={filters.source}
            onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))}
          >
            <option value="">All sources</option>
            <option value="cli">CLI</option>
            <option value="slack">Slack</option>
            <option value="admin">Admin</option>
          </select>
          <input
            placeholder="Search user / assistant text"
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
          />
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
          <AppShellCard
            title="Execution turns"
            subtitle="Stored prompt vs raw request, assistant result, and debug payload"
          >
            {!detail ? (
              <div className="empty-state">
                Execution detail will appear here once you choose a conversation.
              </div>
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
                        tone={
                          turn.status === "completed"
                            ? "success"
                            : turn.status === "failed"
                              ? "error"
                              : "warning"
                        }
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
