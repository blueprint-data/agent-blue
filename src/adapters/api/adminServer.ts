import express, { Request, Response, NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";
import multer from "multer";
import type { ConversationStore } from "../../core/interfaces.js";
import { env } from "../../config/env.js";
import type {
  AdminGuardrails,
  TenantCredentialsRef,
  TenantSnowflakeConfig,
  TenantBigQueryConfig,
  TenantWarehouseProvider
} from "../../core/interfaces.js";
import { initializeTenant } from "../../bootstrap/initTenant.js";
import { GitDbtRepositoryService } from "../dbt/dbtRepoService.js";
import { buildWarehouseFromTenantConfig } from "../../app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] ?? "" : (v ?? "");
}

export interface AdminServerOptions {
  store: ConversationStore;
  port: number;
  appDataDir: string;
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;
  const skipPaths = ["/config", "", "/"];
  const isStatic = /\.(css|js|html|ico|svg|png|jpg|jpeg|gif|woff|woff2|ttf)$/i.test(path);
  if (skipPaths.includes(path) || isStatic) {
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  const basicUser = env.adminBasicUser;
  const basicPassword = env.adminBasicPassword;
  const bearerToken = env.adminUiToken || env.adminBearerToken;
  const hasBasic = basicUser && basicPassword;
  const hasBearer = !!bearerToken;
  if (!hasBasic && !hasBearer) {
    next();
    return;
  }
  if (authHeader?.startsWith("Basic ")) {
    const b64 = authHeader.slice(6);
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const [user, password] = decoded.split(":", 2);
      if (hasBasic && user === basicUser && password === basicPassword) {
        next();
        return;
      }
    } catch {
      // ignore
    }
  }
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (hasBearer && token === bearerToken) {
      next();
      return;
    }
  }
  if (hasBasic) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Agent Blue Admin"');
  }
  res.status(401).json({ error: "Unauthorized" });
}

export function startAdminServer(options: AdminServerOptions): void {
  const { store, port, appDataDir } = options;
  const app = express();
  app.use(express.json());

  app.get("/admin/config", (_req: Request, res: Response) => {
    const bearerToken = env.adminUiToken || env.adminBearerToken;
    const basicEnabled = !!(env.adminBasicUser && env.adminBasicPassword);
    res.json({
      bearerToken: bearerToken || null,
      authRequired: basicEnabled || !!bearerToken,
      basicEnabled,
      basicUser: env.adminBasicUser || null
    });
  });

  app.use("/admin", requireAdminAuth);

  // --- Tenants ---
  app.get("/admin/tenants", (_req: Request, res: Response) => {
    try {
      const tenants = store.listTenants();
      res.json(tenants);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/admin/tenants/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const tenants = store.listTenants();
      const tenant = tenants.find((t) => t.tenantId === tenantId);
      res.json(tenant ?? repo);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/admin/tenants", (req: Request, res: Response) => {
    try {
      const { tenantId, repoUrl, dbtSubpath = "models" } = req.body as {
        tenantId?: string;
        repoUrl?: string;
        dbtSubpath?: string;
      };
      if (!tenantId || !repoUrl) {
        res.status(400).json({ error: "tenantId and repoUrl required" });
        return;
      }
      const result = initializeTenant(
        { appDataDir, tenantId, repoUrl, dbtSubpath, force: false },
        store
      );
      res.status(201).json({
        tenantId,
        repoUrl,
        dbtSubpath,
        localRepoPath: result.localRepoPath,
        message: "Tenant initialized. Add public key as GitHub Deploy Key."
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch("/admin/tenants/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const { repoUrl, dbtSubpath, deployKeyPath } = req.body as {
        repoUrl?: string;
        dbtSubpath?: string;
        deployKeyPath?: string;
      };
      store.upsertTenantRepo({
        tenantId,
        repoUrl: repoUrl ?? repo.repoUrl,
        dbtSubpath: dbtSubpath ?? repo.dbtSubpath,
        deployKeyPath: deployKeyPath ?? repo.deployKeyPath,
        localPath: repo.localPath
      });
      res.json(store.getTenantRepo(tenantId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/admin/tenants/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const keyMeta = store.getTenantKeyMetadata(tenantId);
      if (keyMeta?.filePath && fs.existsSync(keyMeta.filePath)) {
        try {
          fs.unlinkSync(keyMeta.filePath);
        } catch {
          // ignore unlink errors
        }
      }
      store.deleteTenant(tenantId);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const MAX_P8_SIZE = 64 * 1024;
  const uploadP8 = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_P8_SIZE },
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase();
      if (ext !== ".p8") {
        cb(new Error("Only .p8 files are allowed"));
        return;
      }
      cb(null, true);
    }
  });

  app.post(
    "/admin/tenants/:tenantId/key-upload",
    (req: Request, res: Response, next: NextFunction) => {
      uploadP8.single("file")(req, res, (err: unknown) => {
        if (err) {
          const msg = err instanceof Error ? err.message : "Upload failed";
          res.status(400).json({ error: msg });
          return;
        }
        next();
      });
    },
    (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const file = req.file;
      if (!file || !file.buffer) {
        res.status(400).json({ error: "No file uploaded. Use form field 'file' with a .p8 file." });
        return;
      }
      const keysDir = path.join(appDataDir, "keys", tenantId);
      fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
      const fileName = `snowflake_key_${Date.now()}.p8`;
      const filePath = path.join(keysDir, fileName);
      fs.writeFileSync(filePath, file.buffer, { mode: 0o600 });
      const fingerprint = crypto.createHash("sha256").update(file.buffer).digest("hex").slice(0, 16);
      const uploadedAt = new Date().toISOString();
      const existing = store.getTenantKeyMetadata(tenantId);
      if (existing?.filePath && existing.filePath !== filePath && fs.existsSync(existing.filePath)) {
        try {
          fs.unlinkSync(existing.filePath);
        } catch {
          // ignore
        }
      }
      store.upsertTenantKeyMetadata({ tenantId, filePath, uploadedAt, fingerprint });
      const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
      if (warehouseConfig?.provider === "snowflake" && warehouseConfig.snowflake) {
        store.upsertTenantWarehouseConfig({
          ...warehouseConfig,
          snowflake: {
            ...warehouseConfig.snowflake,
            authType: "keypair",
            privateKeyPath: filePath
          }
        });
      }
      res.status(201).json({
        tenantId,
        filePath,
        uploadedAt,
        fingerprint,
        message: "Key uploaded. Warehouse config updated to use keypair auth."
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
  );

  // --- Slack mappings ---
  app.get("/admin/slack-mappings", (_req: Request, res: Response) => {
    try {
      const channels = store.listSlackChannelMappings();
      const users = store.listSlackUserMappings();
      const sharedTeams = store.listSlackSharedTeamMappings();
      res.json({ channels, users, sharedTeams });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/admin/slack-mappings/channels/:channelId", (req: Request, res: Response) => {
    try {
      const channelId = param(req, "channelId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackChannelTenant(channelId, tenantId, "manual");
      res.json({ channelId, tenantId, source: "manual" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/admin/slack-mappings/channels/:channelId", (req: Request, res: Response) => {
    try {
      const channelId = param(req, "channelId");
      store.deleteSlackChannelMapping(channelId);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/admin/slack-mappings/users/:userId", (req: Request, res: Response) => {
    try {
      const userId = param(req, "userId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackUserTenant(userId, tenantId);
      res.json({ userId, tenantId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/admin/slack-mappings/users/:userId", (req: Request, res: Response) => {
    try {
      const userId = param(req, "userId");
      store.deleteSlackUserMapping(userId);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/admin/slack-mappings/shared-teams/:teamId", (req: Request, res: Response) => {
    try {
      const teamId = param(req, "teamId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackSharedTeamTenant(teamId, tenantId);
      res.json({ sharedTeamId: teamId, tenantId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/admin/slack-mappings/shared-teams/:teamId", (req: Request, res: Response) => {
    try {
      const teamId = param(req, "teamId");
      store.deleteSlackSharedTeamMapping(teamId);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Guardrails ---
  app.get("/admin/guardrails", (_req: Request, res: Response) => {
    try {
      const guardrails = store.getGuardrails();
      res.json(guardrails ?? { ownerTeamIds: [], ownerEnterpriseIds: [], strictTenantRouting: false, teamTenantMap: {} });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch("/admin/guardrails", (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<AdminGuardrails>;
      const current = store.getGuardrails();
      const merged: AdminGuardrails = {
        defaultTenantId: body.defaultTenantId ?? current?.defaultTenantId,
        ownerTeamIds: body.ownerTeamIds ?? current?.ownerTeamIds ?? [],
        ownerEnterpriseIds: body.ownerEnterpriseIds ?? current?.ownerEnterpriseIds ?? [],
        strictTenantRouting: body.strictTenantRouting ?? current?.strictTenantRouting ?? false,
        teamTenantMap: body.teamTenantMap ?? current?.teamTenantMap ?? {}
      };
      if (merged.defaultTenantId && !store.getTenantRepo(merged.defaultTenantId)) {
        res.status(400).json({ error: "Default tenant does not exist. Create the tenant first." });
        return;
      }
      const tenantIdsInTeamMap = Object.values(merged.teamTenantMap ?? {});
      for (const tid of tenantIdsInTeamMap) {
        if (!store.getTenantRepo(tid)) {
          res.status(400).json({ error: `Tenant "${tid}" in team map does not exist.` });
          return;
        }
      }
      store.upsertGuardrails(merged);
      res.json(merged);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Credential references ---
  app.get("/admin/credentials-ref/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const ref = store.getTenantCredentialsRef(tenantId);
      const keyMeta = store.getTenantKeyMetadata(tenantId);
      res.json({
        tenantId,
        deployKeyPath: ref?.deployKeyPath ?? repo.deployKeyPath,
        warehouseMetadata: ref?.warehouseMetadata ?? {},
        snowflakeKeyPath: keyMeta?.filePath ?? null,
        snowflakeKeyUploadedAt: keyMeta?.uploadedAt ?? null
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch("/admin/credentials-ref/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const { deployKeyPath, warehouseMetadata } = req.body as Partial<TenantCredentialsRef>;
      const current = store.getTenantCredentialsRef(tenantId);
      const merged: TenantCredentialsRef = {
        tenantId,
        deployKeyPath: deployKeyPath ?? current?.deployKeyPath ?? repo.deployKeyPath,
        warehouseMetadata: warehouseMetadata ?? current?.warehouseMetadata ?? {}
      };
      store.upsertTenantCredentialsRef(merged);
      res.json(merged);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Wizard ---
  const dbtRepo = new GitDbtRepositoryService(store);

  app.post("/admin/tenants/:tenantId/repo-refresh", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({
          status: "failed",
          error: "Tenant not found",
          refreshedAt: null
        });
        return;
      }
      await dbtRepo.syncRepo(tenantId);
      const models = await dbtRepo.listModels(tenantId);
      res.json({
        status: "success",
        message: `Repo refreshed. ${models.length} dbt models found.`,
        refreshedAt: new Date().toISOString(),
        modelCount: models.length
      });
    } catch (err) {
      res.status(500).json({
        status: "failed",
        error: (err as Error).message,
        refreshedAt: null,
        hint: "Ensure the deploy key was added to the GitHub repo as a Deploy Key (read-only)."
      });
    }
  });

  app.post("/admin/wizard/tenant/init", (req: Request, res: Response) => {
    try {
      const { tenantId, repoUrl, dbtSubpath = "models", warehouseProvider = "snowflake" } = req.body as {
        tenantId?: string;
        repoUrl?: string;
        dbtSubpath?: string;
        warehouseProvider?: string;
      };
      if (!tenantId || !repoUrl) {
        res.status(400).json({
          status: "failed",
          error: "tenantId and repoUrl required",
          step: "init"
        });
        return;
      }
      const result = initializeTenant(
        { appDataDir, tenantId, repoUrl, dbtSubpath, force: false },
        store
      );
      res.status(201).json({
        status: "passed",
        step: "init",
        tenantId,
        repoUrl,
        dbtSubpath,
        warehouseProvider,
        localRepoPath: result.localRepoPath,
        publicKey: result.publicKey,
        message: "Tenant initialized. Add the public key as a GitHub Deploy Key (read-only), then verify repo access."
      });
    } catch (err) {
      res.status(500).json({
        status: "failed",
        step: "init",
        error: (err as Error).message
      });
    }
  });

  app.post("/admin/wizard/tenant/:tenantId/repo-verify", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({
          status: "failed",
          step: "repo_verify",
          error: "Tenant not found. Run init first."
        });
        return;
      }
      await dbtRepo.syncRepo(tenantId);
      const models = await dbtRepo.listModels(tenantId);
      res.json({
        status: "passed",
        step: "repo_verify",
        modelCount: models.length,
        message: `Repo synced successfully. ${models.length} dbt models found.`
      });
    } catch (err) {
      res.status(500).json({
        status: "failed",
        step: "repo_verify",
        error: (err as Error).message,
        hint: "Ensure the deploy key was added to the GitHub repo as a Deploy Key (read-only)."
      });
    }
  });

  app.get("/admin/wizard/tenant/:tenantId/state", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
      const channels = store.listSlackChannelMappings().filter((m) => m.tenantId === tenantId);
      const users = store.listSlackUserMappings().filter((m) => m.tenantId === tenantId);
      const sharedTeams = store.listSlackSharedTeamMappings().filter((m) => m.tenantId === tenantId);
      res.json({
        tenantId,
        hasRepo: true,
        hasWarehouseConfig: !!warehouseConfig,
        warehouseProvider: warehouseConfig?.provider,
        slackChannelCount: channels.length,
        slackUserCount: users.length,
        slackSharedTeamCount: sharedTeams.length
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/admin/wizard/tenant/:tenantId/warehouse", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({
          status: "failed",
          step: "warehouse",
          error: "Tenant not found. Run init first."
        });
        return;
      }
      const body = req.body as {
        provider?: TenantWarehouseProvider;
        snowflake?: TenantSnowflakeConfig;
        bigquery?: TenantBigQueryConfig;
      };
      const provider = body.provider ?? "snowflake";
      if (provider === "snowflake") {
        const sf = body.snowflake;
        if (!sf?.account || !sf?.username || !sf?.warehouse || !sf?.database || !sf?.schema) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "Snowflake config requires account, username, warehouse, database, schema."
          });
          return;
        }
        if (sf.authType === "keypair" && !sf.privateKeyPath) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "privateKeyPath required for keypair auth."
          });
          return;
        }
        if (sf.authType === "password" && !sf.passwordEnvVar) {
          sf.passwordEnvVar = "SNOWFLAKE_PASSWORD";
        }
      }
      if (provider === "bigquery") {
        const bq = body.bigquery;
        if (!bq?.projectId) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "BigQuery config requires projectId."
          });
          return;
        }
      }
      store.upsertTenantWarehouseConfig({
        tenantId,
        provider,
        snowflake: body.snowflake,
        bigquery: body.bigquery
      });
      res.json({
        status: "passed",
        step: "warehouse",
        message: "Warehouse config saved. Run warehouse test to verify connectivity."
      });
    } catch (err) {
      res.status(500).json({
        status: "failed",
        step: "warehouse",
        error: (err as Error).message
      });
    }
  });

  app.post("/admin/wizard/tenant/:tenantId/warehouse-test", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const config = store.getTenantWarehouseConfig(tenantId);
      if (!config) {
        res.status(404).json({
          status: "failed",
          step: "warehouse_test",
          error: "Warehouse config not found. Save warehouse config first."
        });
        return;
      }
      if (config.provider === "bigquery") {
        res.status(400).json({
          status: "failed",
          step: "warehouse_test",
          error: "BigQuery warehouse test is not implemented yet."
        });
        return;
      }
      const warehouse = buildWarehouseFromTenantConfig(config);
      const result = await warehouse.query(
        "SELECT CURRENT_ACCOUNT() AS account, CURRENT_ROLE() AS role, CURRENT_DATABASE() AS database_name, CURRENT_SCHEMA() AS schema_name LIMIT 1"
      );
      res.json({
        status: "passed",
        step: "warehouse_test",
        rowCount: result.rowCount,
        sample: result.rows[0],
        message: "Warehouse connectivity verified."
      });
    } catch (err) {
      res.status(500).json({
        status: "failed",
        step: "warehouse_test",
        error: (err as Error).message,
        hint:
          "For Snowflake keypair: ensure privateKeyPath is correct. For password: set the passwordEnvVar in env."
      });
    }
  });

  app.put("/admin/wizard/tenant/:tenantId/slack-mappings", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({
          status: "failed",
          step: "slack_mappings",
          error: "Tenant not found. Run init first."
        });
        return;
      }
      const body = req.body as {
        channels?: Array<{ channelId: string }>;
        users?: Array<{ userId: string }>;
        sharedTeams?: Array<{ sharedTeamId: string }>;
      };
      const channels = body.channels ?? [];
      const users = body.users ?? [];
      const sharedTeams = body.sharedTeams ?? [];
      for (const { channelId } of channels) {
        if (channelId) store.upsertSlackChannelTenant(channelId, tenantId, "wizard");
      }
      for (const { userId } of users) {
        if (userId) store.upsertSlackUserTenant(userId, tenantId);
      }
      for (const { sharedTeamId } of sharedTeams) {
        if (sharedTeamId) store.upsertSlackSharedTeamTenant(sharedTeamId, tenantId);
      }
      res.json({
        status: "passed",
        step: "slack_mappings",
        channelsAdded: channels.length,
        usersAdded: users.length,
        sharedTeamsAdded: sharedTeams.length,
        message: "Slack mappings saved."
      });
    } catch (err) {
      res.status(500).json({
        status: "failed",
        step: "slack_mappings",
        error: (err as Error).message
      });
    }
  });

  app.post("/admin/wizard/tenant/:tenantId/final-validate", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({
          ready: false,
          error: "Tenant not found.",
          checks: []
        });
        return;
      }
      const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
      const channels = store.listSlackChannelMappings().filter((m) => m.tenantId === tenantId);
      const users = store.listSlackUserMappings().filter((m) => m.tenantId === tenantId);
      const sharedTeams = store.listSlackSharedTeamMappings().filter((m) => m.tenantId === tenantId);
      const hasSlackMapping = channels.length > 0 || users.length > 0 || sharedTeams.length > 0;

      const checks: Array<{ name: string; passed: boolean; message?: string }> = [];
      let repoOk = false;
      let warehouseOk = false;

      try {
        await dbtRepo.syncRepo(tenantId);
        const models = await dbtRepo.listModels(tenantId);
        repoOk = true;
        checks.push({ name: "repo_sync", passed: true, message: `${models.length} models` });
      } catch (err) {
        checks.push({ name: "repo_sync", passed: false, message: (err as Error).message });
      }

      if (warehouseConfig && warehouseConfig.provider === "snowflake") {
        try {
          const warehouse = buildWarehouseFromTenantConfig(warehouseConfig);
          await warehouse.query("SELECT 1 AS ok LIMIT 1");
          warehouseOk = true;
          checks.push({ name: "warehouse_connect", passed: true });
        } catch (err) {
          checks.push({ name: "warehouse_connect", passed: false, message: (err as Error).message });
        }
      } else {
        checks.push({
          name: "warehouse_connect",
          passed: false,
          message: "Warehouse config missing or BigQuery not supported."
        });
      }

      checks.push({
        name: "slack_mapping",
        passed: hasSlackMapping,
        message: hasSlackMapping
          ? `${channels.length} channels, ${users.length} users, ${sharedTeams.length} shared teams`
          : "No Slack mappings. Add at least one channel, user, or shared-team mapping."
      });

      const ready = repoOk && warehouseOk && hasSlackMapping;
      res.json({
        ready,
        checks,
        launchCommand: ready
          ? `npm run dev -- slack --profile default --port 3000`
          : undefined,
        message: ready
          ? "Tenant is ready. Start the Slack server with the command above."
          : "Resolve failed checks before go-live."
      });
    } catch (err) {
      res.status(500).json({
        ready: false,
        error: (err as Error).message,
        checks: []
      });
    }
  });

  // --- Static admin UI ---
  const staticDir = path.join(__dirname, "..", "..", "..", "admin-ui");
  app.get("/admin", (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
  app.get("/admin/", (_req: Request, res: Response) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
  app.use("/admin", express.static(staticDir));

  app.listen(port, () => {
    console.log(`Admin server listening on http://localhost:${port}`);
    const hasBasic = !!(env.adminBasicUser && env.adminBasicPassword);
    const hasBearer = !!(env.adminUiToken || env.adminBearerToken);
    if (hasBasic || hasBearer) {
      console.log("Admin API auth enabled: " + (hasBasic ? "Basic " : "") + (hasBearer ? "Bearer" : ""));
    }
    if (env.adminBasicUser && !env.adminBasicPassword) {
      console.warn("ADMIN_BASIC_USER set but ADMIN_BASIC_PASSWORD empty; Basic Auth will not work.");
    }
    if (env.adminBasicPassword && !env.adminBasicUser) {
      console.warn("ADMIN_BASIC_PASSWORD set but ADMIN_BASIC_USER empty; Basic Auth will not work.");
    }
  });
}
