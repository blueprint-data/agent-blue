import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, uploadRequest } from "../api";
import { sectionError } from "../lib/admin";
import type {
  CredentialReference,
  KeyUploadResponse,
  NotifyFn,
  TenantFormState,
  TenantMemoryRecord,
  TenantRecord,
  WizardStateResponse
} from "../types/admin";

export function useTenantAdmin(notify: NotifyFn) {
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialReference | null>(null);
  const [wizardState, setWizardState] = useState<WizardStateResponse | null>(null);
  const [memories, setMemories] = useState<TenantMemoryRecord[]>([]);
  const [form, setForm] = useState<TenantFormState>({ tenantId: "", repoUrl: "", dbtSubpath: "models" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
      setMemories([]);
      return;
    }

    void (async () => {
      try {
        const [nextCredentials, nextWizardState] = await Promise.all([
          apiRequest<CredentialReference>(`/api/admin/credentials-ref/${selectedTenantId}`),
          apiRequest<WizardStateResponse>(`/api/admin/wizard/tenant/${selectedTenantId}/state`)
        ]);
        const nextMemories = await apiRequest<TenantMemoryRecord[]>(
          `/api/admin/tenants/${selectedTenantId}/memories?includeDeleted=1`
        );
        setCredentials(nextCredentials);
        setWizardState(nextWizardState);
        setMemories(nextMemories);
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

  async function handleSave() {
    setSaving(true);
    try {
      if (selectedTenant) {
        await apiRequest(`/api/admin/tenants/${selectedTenant.tenantId}`, {
          method: "PATCH",
          body: {
            repoUrl: form.repoUrl,
            dbtSubpath: form.dbtSubpath
          }
        });
        notify({ type: "success", text: `Updated ${selectedTenant.tenantId}.` });
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

  async function refreshRepo() {
    if (!selectedTenant) return;
    try {
      const result = await apiRequest<{ message: string }>(
        `/api/admin/tenants/${selectedTenant.tenantId}/repo-refresh`,
        {
          method: "POST"
        }
      );
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
      const result = await uploadRequest<KeyUploadResponse>(
        `/api/admin/tenants/${selectedTenant.tenantId}/key-upload`,
        formData
      );
      notify({ type: "success", text: result.message });
      const nextCredentials = await apiRequest<CredentialReference>(
        `/api/admin/credentials-ref/${selectedTenant.tenantId}`
      );
      setCredentials(nextCredentials);
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    }
  }

  function startNewTenant() {
    setSelectedTenantId(null);
    setForm({ tenantId: "", repoUrl: "", dbtSubpath: "models" });
  }

  return {
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
  };
}
