import type { ReactElement } from "react";
import { AppShellCard, DetailItem, PageHeader } from "../components/admin/common";
import { compactText, formatDate } from "../lib/admin";
import { useTenantAdmin } from "../hooks/use-tenant-admin";
import type { NotifyFn } from "../types/admin";

export function TenantsPage({ notify }: { notify: NotifyFn }): ReactElement {
  const {
    tenants,
    selectedTenantId,
    credentials,
    wizardState,
    memories,
    form,
    loading,
    saving,
    fileInputRef,
    selectedTenant,
    setSelectedTenantId,
    setForm,
    handleSave,
    refreshRepo,
    deleteTenant,
    uploadKey,
    startNewTenant
  } = useTenantAdmin(notify);

  return (
    <div className="page-grid">
      <PageHeader
        title="Tenants"
        subtitle="Manage configured tenants, credential references, and day-two operational actions."
        actions={
          <button className="secondary-button" onClick={startNewTenant}>
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
                  onChange={(event) =>
                    setForm((current) => ({ ...current, tenantId: event.target.value }))
                  }
                  disabled={Boolean(selectedTenant)}
                />
              </label>
              <label>
                Repo URL
                <input
                  value={form.repoUrl}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, repoUrl: event.target.value }))
                  }
                />
              </label>
              <label>
                dbt subpath
                <input
                  value={form.dbtSubpath}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, dbtSubpath: event.target.value }))
                  }
                />
              </label>
            </div>
            {selectedTenant ? (
              <div className="button-row">
                <button className="secondary-button" onClick={() => void refreshRepo()}>
                  Refresh repo
                </button>
                <button className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                  Upload .p8 key
                </button>
                <button className="danger-button" onClick={() => void deleteTenant()}>
                  Delete tenant
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
              </div>
            ) : null}
          </AppShellCard>

          <AppShellCard title="Operational metadata" subtitle="Credential references and onboarding state">
            {selectedTenant ? (
              <div className="details-grid">
                <DetailItem label="Deploy key" value={credentials?.deployKeyPath ?? "—"} />
                <DetailItem label="Snowflake .p8" value={credentials?.snowflakeKeyPath ?? "—"} />
                <DetailItem label="Key uploaded" value={formatDate(credentials?.snowflakeKeyUploadedAt)} />
                <DetailItem label="Warehouse configured" value={wizardState?.hasWarehouseConfig ? "Yes" : "No"} />
                <DetailItem label="Slack channels" value={String(wizardState?.slackChannelCount ?? 0)} />
                <DetailItem label="Slack users" value={String(wizardState?.slackUserCount ?? 0)} />
                <DetailItem label="Shared teams" value={String(wizardState?.slackSharedTeamCount ?? 0)} />
                <DetailItem label="Updated" value={formatDate(selectedTenant.updatedAt)} />
              </div>
            ) : (
              <div className="empty-state">Create or select a tenant to inspect operational state.</div>
            )}
          </AppShellCard>

          <AppShellCard title="Tenant memories" subtitle="Shared business context saved from Slack conversations">
            {selectedTenant ? (
              memories.length > 0 ? (
                <div className="list-stack">
                  {memories.map((memory) => (
                    <div key={memory.id} className="list-row">
                      <strong>
                        {memory.id} {memory.status === "deleted" ? "(deleted)" : ""}
                      </strong>
                      <span>{memory.summary}</span>
                      <span className="muted">
                        Updated {formatDate(memory.updatedAt)}
                        {memory.lastUsedAt ? ` · Used ${formatDate(memory.lastUsedAt)}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No tenant memories saved yet.</div>
              )
            ) : (
              <div className="empty-state">Select a tenant to inspect shared memory state.</div>
            )}
          </AppShellCard>
        </div>
      </div>
    </div>
  );
}
