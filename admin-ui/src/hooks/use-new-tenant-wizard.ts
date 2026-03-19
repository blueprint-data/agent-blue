import { useRef, useState } from "react";
import { apiRequest, uploadRequest } from "../api";
import { sectionError } from "../lib/admin";
import type { KeyUploadResponse, NewTenantWizardState, NotifyFn } from "../types/admin";

const initialState: NewTenantWizardState = {
  tenantId: "",
  repoUrl: "",
  dbtSubpath: "models",
  account: "",
  username: "",
  warehouse: "",
  database: "",
  schema: "",
  role: "",
  authType: "keypair",
  privateKeyPath: "",
  passwordEnvVar: "SNOWFLAKE_PASSWORD",
  channelInput: "",
  userInput: "",
  teamInput: "",
  channels: [],
  users: [],
  sharedTeams: [],
  wizardTenantId: null,
  results: {},
  uploadingKey: false
};

export function useNewTenantWizard(notify: NotifyFn) {
  const [state, setState] = useState<NewTenantWizardState>(initialState);
  const wizardKeyInputRef = useRef<HTMLInputElement | null>(null);

  async function runStep(step: string, action: () => Promise<unknown>) {
    try {
      const result = await action();
      setState((current) => ({
        ...current,
        results: { ...current.results, [step]: result }
      }));
      notify({ type: "success", text: `${step.replace(/_/g, " ")} completed.` });
    } catch (caught) {
      const message = sectionError(caught);
      setState((current) => ({
        ...current,
        results: { ...current.results, [step]: { error: message } }
      }));
      notify({ type: "error", text: message });
    }
  }

  async function uploadWizardKey(file: File) {
    if (!state.wizardTenantId) return;
    setState((current) => ({ ...current, uploadingKey: true }));
    const formData = new FormData();
    formData.append("file", file);
    try {
      const result = await uploadRequest<KeyUploadResponse>(
        `/api/admin/tenants/${state.wizardTenantId}/key-upload`,
        formData
      );
      setState((current) => ({
        ...current,
        authType: "keypair",
        privateKeyPath: result.filePath,
        results: { ...current.results, key_upload: result }
      }));
      notify({ type: "success", text: result.message });
    } catch (caught) {
      const message = sectionError(caught);
      setState((current) => ({
        ...current,
        results: { ...current.results, key_upload: { error: message } }
      }));
      notify({ type: "error", text: message });
    } finally {
      setState((current) => ({ ...current, uploadingKey: false }));
    }
  }

  function setField<K extends keyof NewTenantWizardState>(key: K, value: NewTenantWizardState[K]) {
    setState((current) => ({ ...current, [key]: value }));
  }

  function addChannel() {
    if (!state.channelInput) return;
    setState((current) => ({
      ...current,
      channels: [...current.channels, current.channelInput],
      channelInput: ""
    }));
  }

  function addUser() {
    if (!state.userInput) return;
    setState((current) => ({
      ...current,
      users: [...current.users, current.userInput],
      userInput: ""
    }));
  }

  function addTeam() {
    if (!state.teamInput) return;
    setState((current) => ({
      ...current,
      sharedTeams: [...current.sharedTeams, current.teamInput],
      teamInput: ""
    }));
  }

  async function initializeTenant() {
    await runStep("init", async () => {
      const response = await apiRequest<{ tenantId: string; publicKey: string; message: string }>(
        "/api/admin/wizard/tenant/init",
        {
          method: "POST",
          body: {
            tenantId: state.tenantId,
            repoUrl: state.repoUrl,
            dbtSubpath: state.dbtSubpath,
            warehouseProvider: "snowflake"
          }
        }
      );
      setState((current) => ({ ...current, wizardTenantId: response.tenantId }));
      return response;
    });
  }

  async function verifyRepo() {
    if (!state.wizardTenantId) return;
    await runStep("repo_verify", () =>
      apiRequest(`/api/admin/wizard/tenant/${state.wizardTenantId}/repo-verify`, {
        method: "POST"
      })
    );
  }

  async function saveWarehouse() {
    if (!state.wizardTenantId) return;
    await runStep("warehouse", () =>
      apiRequest(`/api/admin/wizard/tenant/${state.wizardTenantId}/warehouse`, {
        method: "PUT",
        body: {
          provider: "snowflake",
          snowflake: {
            account: state.account,
            username: state.username,
            warehouse: state.warehouse,
            database: state.database,
            schema: state.schema,
            role: state.role || undefined,
            authType: state.authType,
            privateKeyPath: state.authType === "keypair" ? state.privateKeyPath || undefined : undefined,
            passwordEnvVar: state.authType === "password" ? state.passwordEnvVar || undefined : undefined
          }
        }
      })
    );
  }

  async function testWarehouse() {
    if (!state.wizardTenantId) return;
    await runStep("warehouse_test", () =>
      apiRequest(`/api/admin/wizard/tenant/${state.wizardTenantId}/warehouse-test`, {
        method: "POST"
      })
    );
  }

  async function saveSlackMappings() {
    if (!state.wizardTenantId) return;
    await runStep("slack_mappings", () =>
      apiRequest(`/api/admin/wizard/tenant/${state.wizardTenantId}/slack-mappings`, {
        method: "PUT",
        body: {
          channels: state.channels.map((channelId) => ({ channelId })),
          users: state.users.map((userId) => ({ userId })),
          sharedTeams: state.sharedTeams.map((sharedTeamId) => ({ sharedTeamId }))
        }
      })
    );
  }

  async function finalValidate() {
    if (!state.wizardTenantId) return;
    await runStep("final_validate", () =>
      apiRequest(`/api/admin/wizard/tenant/${state.wizardTenantId}/final-validate`, {
        method: "POST"
      })
    );
  }

  return {
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
  };
}
