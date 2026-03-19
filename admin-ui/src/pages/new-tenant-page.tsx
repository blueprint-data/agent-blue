import type { ReactElement } from "react";
import { AppShellCard, PageHeader } from "../components/admin/common";
import { JsonBlock } from "../components/admin/json-block";
import { useNewTenantWizard } from "../hooks/use-new-tenant-wizard";
import type { NotifyFn } from "../types/admin";

export function NewTenantPage({ notify }: { notify: NotifyFn }): ReactElement {
  const {
    state,
    wizardKeyInputRef,
    setField,
    addChannel,
    addUser,
    addTeam,
    initializeTenant,
    verifyRepo,
    saveWarehouse,
    testWarehouse,
    saveSlackMappings,
    finalValidate,
    uploadWizardKey
  } = useNewTenantWizard(notify);

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
              <input
                value={state.tenantId}
                onChange={(event) => setField("tenantId", event.target.value)}
                placeholder="acme"
              />
            </label>
            <label>
              Repo URL
              <input
                value={state.repoUrl}
                onChange={(event) => setField("repoUrl", event.target.value)}
                placeholder="git@github.com:org/dbt.git"
              />
            </label>
            <label>
              dbt subpath
              <input
                value={state.dbtSubpath}
                onChange={(event) => setField("dbtSubpath", event.target.value)}
              />
            </label>
          </div>
          <button onClick={() => void initializeTenant()}>Initialize tenant</button>
          {state.results.init ? <JsonBlock value={state.results.init} /> : null}
        </AppShellCard>

        <AppShellCard
          title="2. Verify repo access"
          subtitle="Confirm the deploy key works after you add it on GitHub"
        >
          <button disabled={!state.wizardTenantId} onClick={() => void verifyRepo()}>
            Verify repo
          </button>
          {state.results.repo_verify ? <JsonBlock value={state.results.repo_verify} /> : null}
        </AppShellCard>

        <AppShellCard
          title="3. Configure warehouse"
          subtitle="Store tenant-specific Snowflake connection settings"
        >
          <div className="form-grid">
            <label>
              Account
              <input value={state.account} onChange={(event) => setField("account", event.target.value)} />
            </label>
            <label>
              Username
              <input value={state.username} onChange={(event) => setField("username", event.target.value)} />
            </label>
            <label>
              Warehouse
              <input value={state.warehouse} onChange={(event) => setField("warehouse", event.target.value)} />
            </label>
            <label>
              Database
              <input value={state.database} onChange={(event) => setField("database", event.target.value)} />
            </label>
            <label>
              Schema
              <input value={state.schema} onChange={(event) => setField("schema", event.target.value)} />
            </label>
            <label>
              Role
              <input value={state.role} onChange={(event) => setField("role", event.target.value)} placeholder="Optional" />
            </label>
            <label>
              Auth type
              <select
                value={state.authType}
                onChange={(event) => setField("authType", event.target.value as "keypair" | "password")}
              >
                <option value="keypair">Keypair</option>
                <option value="password">Password</option>
              </select>
            </label>
            {state.authType === "keypair" ? (
              <div className="stack">
                <label>
                  Private key path
                  <input
                    value={state.privateKeyPath}
                    onChange={(event) => setField("privateKeyPath", event.target.value)}
                    placeholder="/path/to/key.p8"
                  />
                </label>
                <div className="button-row">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!state.wizardTenantId || state.uploadingKey}
                    onClick={() => wizardKeyInputRef.current?.click()}
                  >
                    {state.uploadingKey ? "Uploading…" : "Upload .p8 key"}
                  </button>
                  <span className="muted">
                    Upload a Snowflake key to auto-fill the saved file path for this tenant.
                  </span>
                </div>
                <input
                  ref={wizardKeyInputRef}
                  type="file"
                  accept=".p8"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void uploadWizardKey(file);
                    }
                    event.currentTarget.value = "";
                  }}
                />
              </div>
            ) : (
              <label>
                Password env var
                <input
                  value={state.passwordEnvVar}
                  onChange={(event) => setField("passwordEnvVar", event.target.value)}
                />
              </label>
            )}
          </div>
          <button disabled={!state.wizardTenantId} onClick={() => void saveWarehouse()}>
            Save warehouse config
          </button>
          {state.results.key_upload ? <JsonBlock value={state.results.key_upload} /> : null}
          {state.results.warehouse ? <JsonBlock value={state.results.warehouse} /> : null}
        </AppShellCard>

        <AppShellCard title="4. Test warehouse" subtitle="Run a lightweight connection check">
          <button disabled={!state.wizardTenantId} onClick={() => void testWarehouse()}>
            Test connectivity
          </button>
          {state.results.warehouse_test ? <JsonBlock value={state.results.warehouse_test} /> : null}
        </AppShellCard>

        <AppShellCard title="5. Slack mappings" subtitle="Add the Slack contexts that should resolve to this tenant">
          <div className="chip-composer">
            <input
              value={state.channelInput}
              onChange={(event) => setField("channelInput", event.target.value)}
              placeholder="Channel ID"
            />
            <button className="secondary-button" onClick={addChannel}>
              Add channel
            </button>
            <input
              value={state.userInput}
              onChange={(event) => setField("userInput", event.target.value)}
              placeholder="User ID"
            />
            <button className="secondary-button" onClick={addUser}>
              Add user
            </button>
            <input
              value={state.teamInput}
              onChange={(event) => setField("teamInput", event.target.value)}
              placeholder="Shared team ID"
            />
            <button className="secondary-button" onClick={addTeam}>
              Add team
            </button>
          </div>
          <div className="tag-row">
            {state.channels.map((entry) => (
              <span key={entry} className="tag">
                {entry}
              </span>
            ))}
            {state.users.map((entry) => (
              <span key={entry} className="tag">
                {entry}
              </span>
            ))}
            {state.sharedTeams.map((entry) => (
              <span key={entry} className="tag">
                {entry}
              </span>
            ))}
          </div>
          <button disabled={!state.wizardTenantId} onClick={() => void saveSlackMappings()}>
            Save Slack mappings
          </button>
          {state.results.slack_mappings ? <JsonBlock value={state.results.slack_mappings} /> : null}
        </AppShellCard>

        <AppShellCard title="6. Final validation" subtitle="Run the final go-live checks">
          <button disabled={!state.wizardTenantId} onClick={() => void finalValidate()}>
            Run final checks
          </button>
          {state.results.final_validate ? <JsonBlock value={state.results.final_validate} /> : null}
        </AppShellCard>
      </div>
    </div>
  );
}
