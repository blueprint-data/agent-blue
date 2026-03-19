import type { FormEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../api";
import { AppShellCard, PageHeader } from "../components/admin/common";
import { MappingEditor, MappingTable } from "../components/admin/mappings";
import { sectionError } from "../lib/admin";
import type { GuardrailsResponse, MappingDrafts, MappingKind, NotifyFn, SlackMappingsResponse } from "../types/admin";

const emptyDrafts: MappingDrafts = {
  channelId: "",
  channelTenantId: "",
  userId: "",
  userTenantId: "",
  teamId: "",
  teamTenantId: ""
};

export function SettingsPage({ notify }: { notify: NotifyFn }): ReactElement {
  const [guardrails, setGuardrails] = useState<GuardrailsResponse | null>(null);
  const [mappings, setMappings] = useState<SlackMappingsResponse | null>(null);
  const [teamTenantMapText, setTeamTenantMapText] = useState("{}");
  const [mappingDrafts, setMappingDrafts] = useState<MappingDrafts>(emptyDrafts);

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

  async function saveMapping(kind: MappingKind, id: string, tenantId: string) {
    try {
      await apiRequest(`/api/admin/slack-mappings/${kind}/${id}`, {
        method: "PUT",
        body: { tenantId }
      });
      notify({ type: "success", text: `Saved ${kind} mapping.` });
      setMappingDrafts(emptyDrafts);
      await loadSettings();
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  async function deleteMapping(kind: MappingKind, id: string) {
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
      <PageHeader
        title="Settings"
        subtitle="Slack routing defaults, guardrails, and global mapping management."
      />
      <div className="two-column">
        <AppShellCard
          title="Guardrails"
          subtitle="Owner defaults, strict routing, and workspace fallback map"
        >
          {!guardrails ? (
            <div className="muted">Loading…</div>
          ) : (
            <form className="stack" onSubmit={saveGuardrails}>
              <label>
                Default tenant ID
                <input
                  value={guardrails.defaultTenantId ?? ""}
                  onChange={(event) =>
                    setGuardrails((current) =>
                      current ? { ...current, defaultTenantId: event.target.value } : current
                    )
                  }
                />
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
                            ownerTeamIds: event.target.value
                              .split(",")
                              .map((entry) => entry.trim())
                              .filter(Boolean)
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
                            ownerEnterpriseIds: event.target.value
                              .split(",")
                              .map((entry) => entry.trim())
                              .filter(Boolean)
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
                  onChange={(event) =>
                    setGuardrails((current) =>
                      current ? { ...current, strictTenantRouting: event.target.checked } : current
                    )
                  }
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

        <AppShellCard
          title="Slack mappings"
          subtitle="Manage explicit channel, user, and shared-team tenant routing"
        >
          {!mappings ? (
            <div className="muted">Loading…</div>
          ) : (
            <div className="stack">
              <MappingEditor
                label="Channel"
                idValue={mappingDrafts.channelId}
                tenantValue={mappingDrafts.channelTenantId}
                onIdChange={(value) => setMappingDrafts((current) => ({ ...current, channelId: value }))}
                onTenantChange={(value) =>
                  setMappingDrafts((current) => ({ ...current, channelTenantId: value }))
                }
                onSave={() => void saveMapping("channels", mappingDrafts.channelId, mappingDrafts.channelTenantId)}
              />
              <MappingEditor
                label="User"
                idValue={mappingDrafts.userId}
                tenantValue={mappingDrafts.userTenantId}
                onIdChange={(value) => setMappingDrafts((current) => ({ ...current, userId: value }))}
                onTenantChange={(value) =>
                  setMappingDrafts((current) => ({ ...current, userTenantId: value }))
                }
                onSave={() => void saveMapping("users", mappingDrafts.userId, mappingDrafts.userTenantId)}
              />
              <MappingEditor
                label="Shared team"
                idValue={mappingDrafts.teamId}
                tenantValue={mappingDrafts.teamTenantId}
                onIdChange={(value) => setMappingDrafts((current) => ({ ...current, teamId: value }))}
                onTenantChange={(value) =>
                  setMappingDrafts((current) => ({ ...current, teamTenantId: value }))
                }
                onSave={() => void saveMapping("shared-teams", mappingDrafts.teamId, mappingDrafts.teamTenantId)}
              />
              <MappingTable
                title="Channels"
                items={mappings.channels.map((entry) => ({
                  id: entry.channelId,
                  tenantId: entry.tenantId,
                  meta: entry.source
                }))}
                onDelete={(id) => void deleteMapping("channels", id)}
              />
              <MappingTable
                title="Users"
                items={mappings.users.map((entry) => ({ id: entry.userId, tenantId: entry.tenantId }))}
                onDelete={(id) => void deleteMapping("users", id)}
              />
              <MappingTable
                title="Shared teams"
                items={mappings.sharedTeams.map((entry) => ({
                  id: entry.sharedTeamId,
                  tenantId: entry.tenantId
                }))}
                onDelete={(id) => void deleteMapping("shared-teams", id)}
              />
            </div>
          )}
        </AppShellCard>
      </div>
    </div>
  );
}
