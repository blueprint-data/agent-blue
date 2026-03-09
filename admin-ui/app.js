(function () {
  let authBearerToken = null;
  let authBasicHeader = null;
  let authRequired = false;

  function applyAuthHeaders(headers) {
    if (authBearerToken) {
      headers["Authorization"] = "Bearer " + authBearerToken;
      return;
    }
    if (authBasicHeader) {
      headers["Authorization"] = authBasicHeader;
    }
  }

  function clearStoredBasicAuth() {
    try {
      sessionStorage.removeItem("admin_ui_basic_auth");
    } catch {
      // ignore storage access issues
    }
  }

  function loadStoredBasicAuth() {
    try {
      const stored = sessionStorage.getItem("admin_ui_basic_auth");
      if (stored) authBasicHeader = stored;
    } catch {
      // ignore storage access issues
    }
  }

  function promptForBasicAuth(basicUserHint) {
    const user = window.prompt("Admin username", basicUserHint || "admin");
    if (!user) return false;
    const password = window.prompt("Admin password");
    if (!password) return false;
    const encoded = btoa(user + ":" + password);
    authBasicHeader = "Basic " + encoded;
    try {
      sessionStorage.setItem("admin_ui_basic_auth", authBasicHeader);
    } catch {
      // ignore storage access issues
    }
    return true;
  }

  async function loadBootstrapConfig() {
    try {
      const res = await fetch("/admin/config");
      const cfg = await res.json();
      authBearerToken = cfg.bearerToken || null;
      authRequired = cfg.authRequired || false;
      if (!authBearerToken) {
        loadStoredBasicAuth();
        if (!authBasicHeader && cfg.basicEnabled) {
          promptForBasicAuth(cfg.basicUser || "admin");
        }
      }
      const indicator = document.getElementById("auth-indicator");
      if (indicator) {
        if (authRequired && !authBearerToken && !authBasicHeader) {
          indicator.textContent = "Auth required (no token)";
          indicator.className = "auth-indicator auth-fail";
        } else if (authBearerToken || authBasicHeader) {
          indicator.textContent = "Authenticated";
          indicator.className = "auth-indicator auth-ok";
        } else {
          indicator.textContent = "No auth";
          indicator.className = "auth-indicator";
        }
      }
    } catch (err) {
      const indicator = document.getElementById("auth-indicator");
      if (indicator) {
        indicator.textContent = "Config load failed";
        indicator.className = "auth-indicator auth-fail";
      }
      if (authRequired) alert("Could not load admin config. API calls may fail: " + err.message);
    }
  }

  async function api(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };
    applyAuthHeaders(headers);
    const res = await fetch(path, {
      ...options,
      headers,
    });
    if (!res.ok) {
      if (res.status === 401 && authBasicHeader) {
        authBasicHeader = null;
        clearStoredBasicAuth();
      }
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function apiUpload(path, formData) {
    const headers = {};
    applyAuthHeaders(headers);
    const res = await fetch(path, {
      method: "POST",
      headers,
      body: formData,
    });
    if (!res.ok) {
      if (res.status === 401 && authBasicHeader) {
        authBasicHeader = null;
        clearStoredBasicAuth();
      }
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  // --- Tabs ---
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const id = tab.dataset.tab + "-panel";
      document.getElementById(id).classList.add("active");
      if (tab.dataset.tab === "tenants") loadTenants();
      if (tab.dataset.tab === "mappings") loadMappings();
      if (tab.dataset.tab === "guardrails") loadGuardrails();
      if (tab.dataset.tab === "credentials") loadCredentials();
      if (tab.dataset.tab === "wizard") initWizard();
    });
  });

  // --- Wizard ---
  let wizardTenantId = null;
  let wizardPendingChannels = [];
  let wizardPendingUsers = [];
  let wizardPendingTeams = [];

  function setStepBadge(stepNum, status) {
    const badge = document.getElementById("step" + stepNum + "-badge");
    if (!badge) return;
    badge.textContent = status === "passed" ? "OK" : status === "failed" ? "Failed" : status === "in_progress" ? "..." : "—";
    badge.className = "step-badge" + (status ? " " + status : "");
  }

  function showStepResult(elId, passed, message, extra) {
    const el = document.getElementById(elId);
    el.classList.remove("hidden");
    el.className = "step-result " + (passed ? "passed" : "failed");
    el.innerHTML = "<p>" + escapeHtml(message) + "</p>" + (extra ? "<pre>" + escapeHtml(extra) + "</pre>" : "");
  }

  function initWizard() {
    wizardTenantId = document.getElementById("wizard-tenant-id").value.trim() || null;
  }

  document.getElementById("wizard-init-btn").addEventListener("click", async () => {
    const tenantId = document.getElementById("wizard-tenant-id").value.trim();
    const repoUrl = document.getElementById("wizard-repo-url").value.trim();
    const dbtSubpath = document.getElementById("wizard-dbt-subpath").value.trim() || "models";
    const warehouseProvider = document.getElementById("wizard-warehouse-provider").value;
    if (!tenantId || !repoUrl) {
      alert("Tenant ID and Repo URL required");
      return;
    }
    setStepBadge(1, "in_progress");
    try {
      const res = await api("/admin/wizard/tenant/init", {
        method: "POST",
        body: JSON.stringify({ tenantId, repoUrl, dbtSubpath, warehouseProvider }),
      });
      wizardTenantId = tenantId;
      setStepBadge(1, "passed");
      showStepResult(
        "wizard-init-result",
        true,
        res.message,
        "Public key (add as GitHub Deploy Key):\n\n" + res.publicKey
      );
    } catch (err) {
      setStepBadge(1, "failed");
      showStepResult("wizard-init-result", false, err.message);
    }
  });

  document.getElementById("wizard-repo-verify-btn").addEventListener("click", async () => {
    if (!wizardTenantId) {
      alert("Run step 1 first");
      return;
    }
    setStepBadge(2, "in_progress");
    try {
      const res = await api("/admin/wizard/tenant/" + encodeURIComponent(wizardTenantId) + "/repo-verify", {
        method: "POST",
      });
      setStepBadge(2, "passed");
      showStepResult("wizard-repo-result", true, res.message);
    } catch (err) {
      setStepBadge(2, "failed");
      showStepResult("wizard-repo-result", false, err.message);
    }
  });

  document.getElementById("wh-auth-type").addEventListener("change", () => {
    const isKeypair = document.getElementById("wh-auth-type").value === "keypair";
    document.getElementById("wh-keypair-label").classList.toggle("hidden", !isKeypair);
    document.getElementById("wh-password-label").classList.toggle("hidden", isKeypair);
  });

  document.getElementById("wizard-warehouse-save-btn").addEventListener("click", async () => {
    if (!wizardTenantId) {
      alert("Run step 1 first");
      return;
    }
    const authType = document.getElementById("wh-auth-type").value;
    const snowflake = {
      account: document.getElementById("wh-account").value.trim(),
      username: document.getElementById("wh-username").value.trim(),
      warehouse: document.getElementById("wh-warehouse").value.trim(),
      database: document.getElementById("wh-database").value.trim(),
      schema: document.getElementById("wh-schema").value.trim(),
      role: document.getElementById("wh-role").value.trim() || undefined,
      authType,
      privateKeyPath: authType === "keypair" ? document.getElementById("wh-private-key-path").value.trim() || undefined : undefined,
      passwordEnvVar: authType === "password" ? document.getElementById("wh-password-env").value.trim() || "SNOWFLAKE_PASSWORD" : undefined,
    };
    setStepBadge(3, "in_progress");
    try {
      const res = await api("/admin/wizard/tenant/" + encodeURIComponent(wizardTenantId) + "/warehouse", {
        method: "PUT",
        body: JSON.stringify({ provider: "snowflake", snowflake }),
      });
      setStepBadge(3, "passed");
      showStepResult("wizard-warehouse-result", true, res.message);
    } catch (err) {
      setStepBadge(3, "failed");
      showStepResult("wizard-warehouse-result", false, err.message);
    }
  });

  document.getElementById("wizard-warehouse-test-btn").addEventListener("click", async () => {
    if (!wizardTenantId) {
      alert("Run step 1 first");
      return;
    }
    setStepBadge(4, "in_progress");
    try {
      const res = await api("/admin/wizard/tenant/" + encodeURIComponent(wizardTenantId) + "/warehouse-test", {
        method: "POST",
      });
      setStepBadge(4, "passed");
      showStepResult("wizard-warehouse-test-result", true, res.message, JSON.stringify(res.sample, null, 2));
    } catch (err) {
      setStepBadge(4, "failed");
      showStepResult("wizard-warehouse-test-result", false, err.message);
    }
  });

  function renderWizardSlackPending() {
    const parts = [];
    if (wizardPendingChannels.length) parts.push("Channels: " + wizardPendingChannels.join(", "));
    if (wizardPendingUsers.length) parts.push("Users: " + wizardPendingUsers.join(", "));
    if (wizardPendingTeams.length) parts.push("Shared teams: " + wizardPendingTeams.join(", "));
    document.getElementById("wizard-slack-pending").textContent = parts.length ? parts.join(" | ") : "Add at least one mapping, then Save.";
  }

  document.getElementById("wizard-add-channel-btn").addEventListener("click", () => {
    const id = document.getElementById("wizard-channel-id").value.trim();
    if (id) {
      wizardPendingChannels.push(id);
      document.getElementById("wizard-channel-id").value = "";
      renderWizardSlackPending();
    }
  });
  document.getElementById("wizard-add-user-btn").addEventListener("click", () => {
    const id = document.getElementById("wizard-user-id").value.trim();
    if (id) {
      wizardPendingUsers.push(id);
      document.getElementById("wizard-user-id").value = "";
      renderWizardSlackPending();
    }
  });
  document.getElementById("wizard-add-team-btn").addEventListener("click", () => {
    const id = document.getElementById("wizard-team-id").value.trim();
    if (id) {
      wizardPendingTeams.push(id);
      document.getElementById("wizard-team-id").value = "";
      renderWizardSlackPending();
    }
  });

  document.getElementById("wizard-slack-save-btn").addEventListener("click", async () => {
    if (!wizardTenantId) {
      alert("Run step 1 first");
      return;
    }
    if (wizardPendingChannels.length === 0 && wizardPendingUsers.length === 0 && wizardPendingTeams.length === 0) {
      alert("Add at least one channel, user, or shared team mapping");
      return;
    }
    setStepBadge(5, "in_progress");
    try {
      const res = await api("/admin/wizard/tenant/" + encodeURIComponent(wizardTenantId) + "/slack-mappings", {
        method: "PUT",
        body: JSON.stringify({
          channels: wizardPendingChannels.map((c) => ({ channelId: c })),
          users: wizardPendingUsers.map((u) => ({ userId: u })),
          sharedTeams: wizardPendingTeams.map((t) => ({ sharedTeamId: t })),
        }),
      });
      setStepBadge(5, "passed");
      wizardPendingChannels = [];
      wizardPendingUsers = [];
      wizardPendingTeams = [];
      renderWizardSlackPending();
      showStepResult("wizard-slack-result", true, res.message);
    } catch (err) {
      setStepBadge(5, "failed");
      showStepResult("wizard-slack-result", false, err.message);
    }
  });

  document.getElementById("wizard-final-validate-btn").addEventListener("click", async () => {
    if (!wizardTenantId) {
      alert("Run step 1 first");
      return;
    }
    setStepBadge(6, "in_progress");
    try {
      const res = await api("/admin/wizard/tenant/" + encodeURIComponent(wizardTenantId) + "/final-validate", {
        method: "POST",
      });
      setStepBadge(6, res.ready ? "passed" : "failed");
      let html = "<p>" + escapeHtml(res.message) + "</p>";
      if (res.checks && res.checks.length) {
        html += "<ul>";
        res.checks.forEach((c) => {
          html += "<li>" + (c.passed ? "✓" : "✗") + " " + escapeHtml(c.name) + (c.message ? ": " + escapeHtml(c.message) : "") + "</li>";
        });
        html += "</ul>";
      }
      if (res.launchCommand) {
        html += "<p><strong>Launch command:</strong></p><pre>" + escapeHtml(res.launchCommand) + "</pre>";
      }
      const el = document.getElementById("wizard-final-result");
      el.classList.remove("hidden");
      el.className = "step-result " + (res.ready ? "passed" : "failed");
      el.innerHTML = html;
    } catch (err) {
      setStepBadge(6, "failed");
      showStepResult("wizard-final-result", false, err.message);
    }
  });

  // --- Tenants ---
  const tenantsList = document.getElementById("tenants-list");
  const tenantForm = document.getElementById("tenant-form");
  const createTenantBtn = document.getElementById("create-tenant-btn");

  createTenantBtn.addEventListener("click", () => {
    tenantForm.classList.remove("hidden");
    document.getElementById("tenant-id").value = "";
    document.getElementById("tenant-repo-url").value = "";
    document.getElementById("tenant-dbt-subpath").value = "models";
    document.getElementById("tenant-id").disabled = false;
  });

  tenantForm.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const tenantId = document.getElementById("tenant-id").value.trim();
    const repoUrl = document.getElementById("tenant-repo-url").value.trim();
    const dbtSubpath = document.getElementById("tenant-dbt-subpath").value.trim() || "models";
    try {
      if (document.getElementById("tenant-id").disabled) {
        await api("/admin/tenants/" + encodeURIComponent(tenantId), {
          method: "PATCH",
          body: JSON.stringify({ repoUrl, dbtSubpath }),
        });
      } else {
        await api("/admin/tenants", {
          method: "POST",
          body: JSON.stringify({ tenantId, repoUrl, dbtSubpath }),
        });
      }
      tenantForm.classList.add("hidden");
      loadTenants();
    } catch (err) {
      alert(err.message);
    }
  });

  tenantForm.querySelector(".cancel-btn").addEventListener("click", () => {
    tenantForm.classList.add("hidden");
  });

  let p8UploadTenantId = null;
  const p8FileInput = document.getElementById("p8-file-input");

  function triggerP8Upload(tenantId) {
    p8UploadTenantId = tenantId;
    p8FileInput.value = "";
    p8FileInput.click();
  }

  p8FileInput.addEventListener("change", async () => {
    const tenantId = p8UploadTenantId;
    p8UploadTenantId = null;
    if (!tenantId || !p8FileInput.files?.length) return;
    const file = p8FileInput.files[0];
    if (!file.name.toLowerCase().endsWith(".p8")) {
      alert("Please select a .p8 file.");
      return;
    }
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiUpload("/admin/tenants/" + encodeURIComponent(tenantId) + "/key-upload", formData);
      alert(res.message || "Key uploaded successfully.");
      loadTenants();
      if (document.querySelector(".tab[data-tab=credentials].active")) loadCredentials();
    } catch (err) {
      alert("Upload failed: " + err.message);
    }
  });

  async function refreshRepo(tenantId) {
    try {
      const res = await api("/admin/tenants/" + encodeURIComponent(tenantId) + "/repo-refresh", {
        method: "POST",
      });
      if (res.status === "success") {
        alert(res.message || "Repo refreshed.");
      } else {
        alert("Refresh failed: " + (res.error || "Unknown error") + (res.hint ? "\n\n" + res.hint : ""));
      }
      loadTenants();
    } catch (err) {
      alert("Refresh failed: " + err.message);
    }
  }

  async function loadTenants() {
    tenantsList.innerHTML = "<p class='loading'>Loading...</p>";
    try {
      const tenants = await api("/admin/tenants");
      if (tenants.length === 0) {
        tenantsList.innerHTML = "<p class='hint'>No tenants. Create one to get started.</p>";
        return;
      }
      tenantsList.innerHTML = tenants
        .map(
          (t) =>
            `<div class="table-row">
              <span>${escapeHtml(t.tenantId)}</span>
              <span class="muted">${escapeHtml(t.repoUrl)}</span>
              <div>
                <button class="upload-p8-tenant" data-id="${escapeHtml(t.tenantId)}">Upload .p8</button>
                <button class="refresh-repo-tenant" data-id="${escapeHtml(t.tenantId)}">Refresh repo</button>
                <button class="edit-tenant" data-id="${escapeHtml(t.tenantId)}" data-repo="${escapeHtml(t.repoUrl)}" data-dbt="${escapeHtml(t.dbtSubpath)}">Edit</button>
                <button class="delete-tenant danger" data-id="${escapeHtml(t.tenantId)}">Delete</button>
              </div>
            </div>`
        )
        .join("");
      tenantsList.querySelectorAll(".edit-tenant").forEach((btn) => {
        btn.addEventListener("click", () => {
          tenantForm.classList.remove("hidden");
          document.getElementById("tenant-id").value = btn.dataset.id;
          document.getElementById("tenant-id").disabled = true;
          document.getElementById("tenant-repo-url").value = btn.dataset.repo;
          document.getElementById("tenant-dbt-subpath").value = btn.dataset.dbt;
        });
      });
      tenantsList.querySelectorAll(".delete-tenant").forEach((btn) => {
        btn.addEventListener("click", () => showDeleteModal("tenant", btn.dataset.id, "Tenant " + btn.dataset.id + " and all associated data (mappings, conversations, profiles) will be permanently deleted."));
      });
      tenantsList.querySelectorAll(".upload-p8-tenant").forEach((btn) => {
        btn.addEventListener("click", () => triggerP8Upload(btn.dataset.id));
      });
      tenantsList.querySelectorAll(".refresh-repo-tenant").forEach((btn) => {
        btn.addEventListener("click", () => refreshRepo(btn.dataset.id));
      });
    } catch (err) {
      tenantsList.innerHTML = "<p class='hint'>" + escapeHtml(err.message) + "</p>";
    }
  }

  // --- Mappings ---
  const channelsList = document.getElementById("channels-list");
  const usersList = document.getElementById("users-list");
  const teamsList = document.getElementById("teams-list");

  async function loadMappings() {
    channelsList.innerHTML = usersList.innerHTML = teamsList.innerHTML = "<p class='loading'>Loading...</p>";
    try {
      const { channels, users, sharedTeams } = await api("/admin/slack-mappings");
      renderMappings(channelsList, channels, "channel", "channelId", "tenantId", "source");
      renderMappings(usersList, users, "user", "userId", "tenantId");
      renderMappings(teamsList, sharedTeams, "sharedTeam", "sharedTeamId", "tenantId");
    } catch (err) {
      channelsList.innerHTML = usersList.innerHTML = teamsList.innerHTML = "<p class='hint'>" + escapeHtml(err.message) + "</p>";
    }
  }

  function renderMappings(container, items, type, idKey, tenantKey, extraKey) {
    if (!items || items.length === 0) {
      container.innerHTML = "<p class='hint'>None</p>";
      return;
    }
    container.innerHTML = items
      .map(
        (m) =>
          `<div class="table-row">
            <span>${escapeHtml(m[idKey])} → ${escapeHtml(m[tenantKey])}${extraKey && m[extraKey] ? " (" + escapeHtml(m[extraKey]) + ")" : ""}</span>
            <button class="delete-mapping danger" data-type="${type}" data-id="${escapeHtml(m[idKey])}">Delete</button>
          </div>`
      )
      .join("");
    container.querySelectorAll(".delete-mapping").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.type;
        const id = btn.dataset.id;
        const path =
          type === "channel"
            ? "/admin/slack-mappings/channels/"
            : type === "user"
              ? "/admin/slack-mappings/users/"
              : "/admin/slack-mappings/shared-teams/";
        api(path + encodeURIComponent(id), { method: "DELETE" }).then(() => loadMappings()).catch((e) => alert(e.message));
      });
    });
  }

  function addMapping(path, idInputId, tenantInputId, btnId) {
    document.getElementById(btnId).addEventListener("click", async () => {
      const id = document.getElementById(idInputId).value.trim();
      const tenantId = document.getElementById(tenantInputId).value.trim();
      if (!id || !tenantId) {
        alert("ID and tenant are required");
        return;
      }
      try {
        await api(path + encodeURIComponent(id), {
          method: "PUT",
          body: JSON.stringify({ tenantId }),
        });
        document.getElementById(idInputId).value = "";
        document.getElementById(tenantInputId).value = "";
        loadMappings();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  addMapping("/admin/slack-mappings/channels/", "new-channel-id", "new-channel-tenant", "add-channel-btn");
  addMapping("/admin/slack-mappings/users/", "new-user-id", "new-user-tenant", "add-user-btn");
  addMapping("/admin/slack-mappings/shared-teams/", "new-team-id", "new-team-tenant", "add-team-btn");

  // --- Guardrails ---
  const guardrailsForm = document.getElementById("guardrails-form");

  async function loadGuardrails() {
    try {
      const g = await api("/admin/guardrails");
      document.getElementById("guard-default-tenant").value = g.defaultTenantId || "";
      document.getElementById("guard-owner-teams").value = (g.ownerTeamIds || []).join(", ");
      document.getElementById("guard-owner-enterprises").value = (g.ownerEnterpriseIds || []).join(", ");
      document.getElementById("guard-strict").checked = g.strictTenantRouting || false;
      document.getElementById("guard-team-map").value = JSON.stringify(g.teamTenantMap || {}, null, 2);
    } catch (err) {
      alert(err.message);
    }
  }

  guardrailsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ownerTeams = document.getElementById("guard-owner-teams").value.split(",").map((s) => s.trim()).filter(Boolean);
    const ownerEnterprises = document.getElementById("guard-owner-enterprises").value.split(",").map((s) => s.trim()).filter(Boolean);
    let teamMap = {};
    try {
      const raw = document.getElementById("guard-team-map").value.trim();
      if (raw) teamMap = JSON.parse(raw);
    } catch {
      alert("Invalid JSON in team map");
      return;
    }
    try {
      await api("/admin/guardrails", {
        method: "PATCH",
        body: JSON.stringify({
          defaultTenantId: document.getElementById("guard-default-tenant").value.trim() || undefined,
          ownerTeamIds: ownerTeams,
          ownerEnterpriseIds: ownerEnterprises,
          strictTenantRouting: document.getElementById("guard-strict").checked,
          teamTenantMap: teamMap,
        }),
      });
      alert("Saved");
    } catch (err) {
      alert(err.message);
    }
  });

  // --- Credentials ---
  const credentialsList = document.getElementById("credentials-list");

  async function loadCredentials() {
    credentialsList.innerHTML = "<p class='loading'>Loading...</p>";
    try {
      const tenants = await api("/admin/tenants");
      if (tenants.length === 0) {
        credentialsList.innerHTML = "<p class='hint'>No tenants. Credential refs are per-tenant.</p>";
        return;
      }
      const refs = await Promise.all(
        tenants.map(async (t) => {
          try {
            const ref = await api("/admin/credentials-ref/" + encodeURIComponent(t.tenantId));
            return { tenantId: t.tenantId, ...ref };
          } catch {
            return { tenantId: t.tenantId, deployKeyPath: t.deployKeyPath, warehouseMetadata: {} };
          }
        })
      );
      credentialsList.innerHTML = refs
        .map(
          (r) =>
            `<div class="table-row">
              <div>
                <strong>${escapeHtml(r.tenantId)}</strong>
                <div class="hint">Deploy key: ${escapeHtml(r.deployKeyPath || "—")}</div>
                ${r.snowflakeKeyPath ? "<div class='hint'>Snowflake .p8 key: " + escapeHtml(r.snowflakeKeyPath) + (r.snowflakeKeyUploadedAt ? " (uploaded " + escapeHtml(r.snowflakeKeyUploadedAt.slice(0, 10)) + ")" : "") + "</div>" : ""}
                ${r.warehouseMetadata && Object.keys(r.warehouseMetadata).length ? "<div class='hint'>Warehouse: " + escapeHtml(JSON.stringify(r.warehouseMetadata)) + "</div>" : ""}
              </div>
            </div>`
        )
        .join("");
    } catch (err) {
      credentialsList.innerHTML = "<p class='hint'>" + escapeHtml(err.message) + "</p>";
    }
  }

  // --- Delete modal ---
  const deleteModal = document.getElementById("delete-modal");
  const deleteMessage = document.getElementById("delete-message");
  const deleteConfirmBtn = document.getElementById("delete-confirm-btn");
  const deleteCancelBtn = document.getElementById("delete-cancel-btn");

  let pendingDelete = null;

  function showDeleteModal(type, id, message) {
    pendingDelete = { type, id };
    deleteMessage.textContent = message;
    deleteModal.classList.remove("hidden");
  }

  deleteCancelBtn.addEventListener("click", () => {
    deleteModal.classList.add("hidden");
    pendingDelete = null;
  });

  deleteConfirmBtn.addEventListener("click", async () => {
    if (!pendingDelete) return;
    const { type, id } = pendingDelete;
    try {
      if (type === "tenant") {
        await api("/admin/tenants/" + encodeURIComponent(id), { method: "DELETE" });
        loadTenants();
      }
    } catch (err) {
      alert(err.message);
    }
    deleteModal.classList.add("hidden");
    pendingDelete = null;
  });

  // --- Init ---
  function init() {
    const activeTab = document.querySelector(".tab.active");
    if (activeTab) {
      if (activeTab.dataset.tab === "tenants") loadTenants();
      if (activeTab.dataset.tab === "mappings") loadMappings();
      if (activeTab.dataset.tab === "guardrails") loadGuardrails();
      if (activeTab.dataset.tab === "credentials") loadCredentials();
    }
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  (async function main() {
    await loadBootstrapConfig();
    init();
  })();
})();
