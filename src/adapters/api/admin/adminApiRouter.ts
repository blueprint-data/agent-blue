import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import type { ConversationStore } from "../../../core/interfaces.js";
import type {
  AdminGuardrails,
  TenantBigQueryConfig,
  TenantCredentialsRef,
  TenantSnowflakeConfig,
  TenantWarehouseProvider
} from "../../../core/interfaces.js";
import { initializeTenant } from "../../../bootstrap/initTenant.js";
import { buildWarehouseFromTenantConfig } from "../../../app.js";
import { GitDbtRepositoryService } from "../../dbt/dbtRepoService.js";
import type { SlackBotSupervisor } from "./slackBotSupervisor.js";
import type { TelegramBotSupervisor } from "./telegramBotSupervisor.js";

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? "" : (value ?? "");
}

export interface AdminApiRouterOptions {
  store: ConversationStore;
  appDataDir: string;
  slackBotSupervisor?: SlackBotSupervisor;
  telegramBotSupervisor?: TelegramBotSupervisor;
}

export function createAdminApiRouter(options: AdminApiRouterOptions): Router {
  const { store, appDataDir, slackBotSupervisor, telegramBotSupervisor } = options;
  const router = Router();
  const dbtRepo = new GitDbtRepositoryService(store);

  router.get("/tenants", (_req: Request, res: Response) => {
    try {
      res.json(store.listTenants());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/tenants/:tenantId", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const tenant = store.listTenants().find((entry) => entry.tenantId === tenantId);
      res.json(tenant ?? repo);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/tenants", (req: Request, res: Response) => {
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
      const result = initializeTenant({ appDataDir, tenantId, repoUrl, dbtSubpath, force: false }, store);
      res.status(201).json({
        tenantId,
        repoUrl,
        dbtSubpath,
        localRepoPath: result.localRepoPath,
        message: "Tenant initialized. Add public key as GitHub Deploy Key."
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.patch("/tenants/:tenantId", (req: Request, res: Response) => {
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/tenants/:tenantId", (req: Request, res: Response) => {
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  const maxP8Size = 64 * 1024;
  const uploadP8 = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxP8Size },
    fileFilter(_req, file, cb) {
      if (path.extname(file.originalname || "").toLowerCase() !== ".p8") {
        cb(new Error("Only .p8 files are allowed"));
        return;
      }
      cb(null, true);
    }
  });

  router.post(
    "/tenants/:tenantId/key-upload",
    (req: Request, res: Response, next: NextFunction) => {
      uploadP8.single("file")(req, res, (error: unknown) => {
        if (error) {
          const message = error instanceof Error ? error.message : "Upload failed";
          res.status(400).json({ error: message });
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
        if (!file?.buffer) {
          res.status(400).json({ error: "No file uploaded. Use form field 'file' with a .p8 file." });
          return;
        }
        const keysDir = path.join(appDataDir, "keys", tenantId);
        fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
        const filePath = path.join(keysDir, `snowflake_key_${Date.now()}.p8`);
        fs.writeFileSync(filePath, file.buffer, { mode: 0o600 });
        const fingerprint = crypto.createHash("sha256").update(file.buffer).digest("hex").slice(0, 16);
        const uploadedAt = new Date().toISOString();
        const existing = store.getTenantKeyMetadata(tenantId);
        if (existing?.filePath && existing.filePath !== filePath && fs.existsSync(existing.filePath)) {
          try {
            fs.unlinkSync(existing.filePath);
          } catch {
            // ignore cleanup errors
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
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  router.post("/tenants/:tenantId/repo-refresh", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      const repo = store.getTenantRepo(tenantId);
      if (!repo) {
        res.status(404).json({ status: "failed", error: "Tenant not found", refreshedAt: null });
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
    } catch (error) {
      res.status(500).json({
        status: "failed",
        error: (error as Error).message,
        refreshedAt: null,
        hint: "Ensure the deploy key was added to the GitHub repo as a Deploy Key (read-only)."
      });
    }
  });

  router.get("/slack-mappings", (_req: Request, res: Response) => {
    try {
      res.json({
        channels: store.listSlackChannelMappings(),
        users: store.listSlackUserMappings(),
        sharedTeams: store.listSlackSharedTeamMappings()
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/slack-mappings/channels/:channelId", (req: Request, res: Response) => {
    try {
      const channelId = param(req, "channelId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackChannelTenant(channelId, tenantId, "manual");
      res.json({ channelId, tenantId, source: "manual" });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/slack-mappings/channels/:channelId", (req: Request, res: Response) => {
    try {
      store.deleteSlackChannelMapping(param(req, "channelId"));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/slack-mappings/users/:userId", (req: Request, res: Response) => {
    try {
      const userId = param(req, "userId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackUserTenant(userId, tenantId);
      res.json({ userId, tenantId });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/slack-mappings/users/:userId", (req: Request, res: Response) => {
    try {
      store.deleteSlackUserMapping(param(req, "userId"));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/slack-mappings/shared-teams/:teamId", (req: Request, res: Response) => {
    try {
      const teamId = param(req, "teamId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertSlackSharedTeamTenant(teamId, tenantId);
      res.json({ sharedTeamId: teamId, tenantId });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/slack-mappings/shared-teams/:teamId", (req: Request, res: Response) => {
    try {
      store.deleteSlackSharedTeamMapping(param(req, "teamId"));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/guardrails", (_req: Request, res: Response) => {
    try {
      res.json(
        store.getGuardrails() ?? {
          ownerTeamIds: [],
          ownerEnterpriseIds: [],
          strictTenantRouting: false,
          teamTenantMap: {}
        }
      );
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.patch("/guardrails", (req: Request, res: Response) => {
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
      for (const tenantId of Object.values(merged.teamTenantMap ?? {})) {
        if (!store.getTenantRepo(tenantId)) {
          res.status(400).json({ error: `Tenant "${tenantId}" in team map does not exist.` });
          return;
        }
      }
      store.upsertGuardrails(merged);
      res.json(merged);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/credentials-ref/:tenantId", (req: Request, res: Response) => {
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.patch("/credentials-ref/:tenantId", (req: Request, res: Response) => {
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/tenants/:tenantId/warehouse", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const config = store.getTenantWarehouseConfig(tenantId);
      if (!config) {
        res.json({ tenantId, provider: null });
        return;
      }
      const sanitized: Record<string, unknown> = {
        tenantId: config.tenantId,
        provider: config.provider,
        updatedAt: config.updatedAt
      };
      if (config.provider === "snowflake" && config.snowflake) {
        sanitized.snowflake = {
          account: config.snowflake.account,
          username: config.snowflake.username,
          warehouse: config.snowflake.warehouse,
          database: config.snowflake.database,
          schema: config.snowflake.schema,
          role: config.snowflake.role,
          authType: config.snowflake.authType
        };
      }
      if (config.provider === "bigquery" && config.bigquery) {
        sanitized.bigquery = {
          projectId: config.bigquery.projectId,
          dataset: config.bigquery.dataset,
          location: config.bigquery.location
        };
      }
      res.json(sanitized);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/telegram-mappings", (_req: Request, res: Response) => {
    try {
      res.json(store.listTelegramChatMappings());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/telegram-mappings/:chatId", (req: Request, res: Response) => {
    try {
      const chatId = param(req, "chatId");
      const { tenantId } = req.body as { tenantId?: string };
      if (!tenantId) {
        res.status(400).json({ error: "tenantId required" });
        return;
      }
      if (!store.getTenantRepo(tenantId)) {
        res.status(400).json({ error: "Tenant not found" });
        return;
      }
      store.upsertTelegramChatTenant(chatId, tenantId, "manual");
      res.json({ chatId, tenantId, source: "manual" });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete("/telegram-mappings/:chatId", (req: Request, res: Response) => {
    try {
      store.deleteTelegramChatMapping(param(req, "chatId"));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/telegram-bot/status", (_req: Request, res: Response) => {
    try {
      if (!telegramBotSupervisor) {
        res.status(503).json({ error: "Telegram bot supervisor unavailable" });
        return;
      }
      res.json(telegramBotSupervisor.getStatus());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/telegram-bot/events", (req: Request, res: Response) => {
    try {
      if (!telegramBotSupervisor) {
        res.status(503).json({ error: "Telegram bot supervisor unavailable" });
        return;
      }
      const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 100;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
      res.json(telegramBotSupervisor.listEvents(limit));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/telegram-bot/start", async (_req: Request, res: Response) => {
    try {
      if (!telegramBotSupervisor) {
        res.status(503).json({ error: "Telegram bot supervisor unavailable" });
        return;
      }
      res.json(await telegramBotSupervisor.start());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/telegram-bot/stop", async (_req: Request, res: Response) => {
    try {
      if (!telegramBotSupervisor) {
        res.status(503).json({ error: "Telegram bot supervisor unavailable" });
        return;
      }
      res.json(await telegramBotSupervisor.stop());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/telegram-bot/restart", async (_req: Request, res: Response) => {
    try {
      if (!telegramBotSupervisor) {
        res.status(503).json({ error: "Telegram bot supervisor unavailable" });
        return;
      }
      res.json(await telegramBotSupervisor.restart());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/conversations", (req: Request, res: Response) => {
    try {
      const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
      const source = typeof req.query.source === "string" ? req.query.source : undefined;
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 100;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
      res.json(
        store.listAdminConversations({
          tenantId,
          source: source as "cli" | "slack" | "admin" | undefined,
          search,
          limit
        })
      );
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/conversations/:conversationId", (req: Request, res: Response) => {
    try {
      const detail = store.getAdminConversationDetail(param(req, "conversationId"));
      if (!detail) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json(detail);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/execution-turns/:turnId", (req: Request, res: Response) => {
    try {
      const turn = store.getExecutionTurn(param(req, "turnId"));
      if (!turn) {
        res.status(404).json({ error: "Execution turn not found" });
        return;
      }
      res.json(turn);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/bot/status", (_req: Request, res: Response) => {
    try {
      if (!slackBotSupervisor) {
        res.status(503).json({ error: "Slack bot supervisor unavailable" });
        return;
      }
      res.json(slackBotSupervisor.getStatus());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/bot/events", (req: Request, res: Response) => {
    try {
      if (!slackBotSupervisor) {
        res.status(503).json({ error: "Slack bot supervisor unavailable" });
        return;
      }
      const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 100;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
      res.json(slackBotSupervisor.listEvents(limit));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/bot/start", async (req: Request, res: Response) => {
    try {
      if (!slackBotSupervisor) {
        res.status(503).json({ error: "Slack bot supervisor unavailable" });
        return;
      }
      const port = typeof req.body?.port === "number" ? req.body.port : undefined;
      const status = await slackBotSupervisor.start(port);
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/bot/stop", async (_req: Request, res: Response) => {
    try {
      if (!slackBotSupervisor) {
        res.status(503).json({ error: "Slack bot supervisor unavailable" });
        return;
      }
      res.json(await slackBotSupervisor.stop());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/bot/restart", async (req: Request, res: Response) => {
    try {
      if (!slackBotSupervisor) {
        res.status(503).json({ error: "Slack bot supervisor unavailable" });
        return;
      }
      const port = typeof req.body?.port === "number" ? req.body.port : undefined;
      res.json(await slackBotSupervisor.restart(port));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post("/wizard/tenant/init", (req: Request, res: Response) => {
    try {
      const { tenantId, repoUrl, dbtSubpath = "models", warehouseProvider = "snowflake" } = req.body as {
        tenantId?: string;
        repoUrl?: string;
        dbtSubpath?: string;
        warehouseProvider?: string;
      };
      if (!tenantId || !repoUrl) {
        res.status(400).json({ status: "failed", error: "tenantId and repoUrl required", step: "init" });
        return;
      }
      const result = initializeTenant({ appDataDir, tenantId, repoUrl, dbtSubpath, force: false }, store);
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
    } catch (error) {
      res.status(500).json({ status: "failed", step: "init", error: (error as Error).message });
    }
  });

  router.post("/wizard/tenant/:tenantId/repo-verify", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (!store.getTenantRepo(tenantId)) {
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
    } catch (error) {
      res.status(500).json({
        status: "failed",
        step: "repo_verify",
        error: (error as Error).message,
        hint: "Ensure the deploy key was added to the GitHub repo as a Deploy Key (read-only)."
      });
    }
  });

  router.get("/wizard/tenant/:tenantId/state", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }
      const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
      const channels = store.listSlackChannelMappings().filter((entry) => entry.tenantId === tenantId);
      const users = store.listSlackUserMappings().filter((entry) => entry.tenantId === tenantId);
      const sharedTeams = store.listSlackSharedTeamMappings().filter((entry) => entry.tenantId === tenantId);
      res.json({
        tenantId,
        hasRepo: true,
        hasWarehouseConfig: !!warehouseConfig,
        warehouseProvider: warehouseConfig?.provider,
        slackChannelCount: channels.length,
        slackUserCount: users.length,
        slackSharedTeamCount: sharedTeams.length
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.put("/wizard/tenant/:tenantId/warehouse", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ status: "failed", step: "warehouse", error: "Tenant not found. Run init first." });
        return;
      }
      const body = req.body as {
        provider?: TenantWarehouseProvider;
        snowflake?: TenantSnowflakeConfig;
        bigquery?: TenantBigQueryConfig;
      };
      const provider = body.provider ?? "snowflake";
      if (provider === "snowflake") {
        const snowflake = body.snowflake;
        if (
          !snowflake?.account ||
          !snowflake.username ||
          !snowflake.warehouse ||
          !snowflake.database ||
          !snowflake.schema
        ) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "Snowflake config requires account, username, warehouse, database, schema."
          });
          return;
        }
        if (snowflake.authType === "keypair" && !snowflake.privateKeyPath) {
          res.status(400).json({
            status: "failed",
            step: "warehouse",
            error: "privateKeyPath required for keypair auth."
          });
          return;
        }
        if (snowflake.authType === "password" && !snowflake.passwordEnvVar) {
          snowflake.passwordEnvVar = "SNOWFLAKE_PASSWORD";
        }
      }
      if (provider === "bigquery" && !body.bigquery?.projectId) {
        res.status(400).json({
          status: "failed",
          step: "warehouse",
          error: "BigQuery config requires projectId."
        });
        return;
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
    } catch (error) {
      res.status(500).json({ status: "failed", step: "warehouse", error: (error as Error).message });
    }
  });

  router.post("/wizard/tenant/:tenantId/warehouse-test", async (req: Request, res: Response) => {
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
      const warehouse = buildWarehouseFromTenantConfig(config);
      const testQuery = config.provider === "bigquery"
        ? "SELECT 1 AS test"
        : "SELECT CURRENT_ACCOUNT() AS account, CURRENT_ROLE() AS role, CURRENT_DATABASE() AS database_name, CURRENT_SCHEMA() AS schema_name LIMIT 1";
      const result = await warehouse.query(testQuery);
      res.json({
        status: "passed",
        step: "warehouse_test",
        rowCount: result.rowCount,
        sample: result.rows[0],
        message: "Warehouse connectivity verified."
      });
    } catch (error) {
      res.status(500).json({
        status: "failed",
        step: "warehouse_test",
        error: (error as Error).message,
        hint: "For Snowflake keypair: ensure privateKeyPath is correct. For password: set the passwordEnvVar in env."
      });
    }
  });

  router.put("/wizard/tenant/:tenantId/slack-mappings", (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (!store.getTenantRepo(tenantId)) {
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
        if (channelId) {
          store.upsertSlackChannelTenant(channelId, tenantId, "wizard");
        }
      }
      for (const { userId } of users) {
        if (userId) {
          store.upsertSlackUserTenant(userId, tenantId);
        }
      }
      for (const { sharedTeamId } of sharedTeams) {
        if (sharedTeamId) {
          store.upsertSlackSharedTeamTenant(sharedTeamId, tenantId);
        }
      }
      res.json({
        status: "passed",
        step: "slack_mappings",
        channelsAdded: channels.length,
        usersAdded: users.length,
        sharedTeamsAdded: sharedTeams.length,
        message: "Slack mappings saved."
      });
    } catch (error) {
      res.status(500).json({ status: "failed", step: "slack_mappings", error: (error as Error).message });
    }
  });

  router.post("/wizard/tenant/:tenantId/final-validate", async (req: Request, res: Response) => {
    try {
      const tenantId = param(req, "tenantId");
      if (!store.getTenantRepo(tenantId)) {
        res.status(404).json({ ready: false, error: "Tenant not found.", checks: [] });
        return;
      }
      const warehouseConfig = store.getTenantWarehouseConfig(tenantId);
      const channels = store.listSlackChannelMappings().filter((entry) => entry.tenantId === tenantId);
      const users = store.listSlackUserMappings().filter((entry) => entry.tenantId === tenantId);
      const sharedTeams = store.listSlackSharedTeamMappings().filter((entry) => entry.tenantId === tenantId);
      const hasSlackMapping = channels.length > 0 || users.length > 0 || sharedTeams.length > 0;

      const checks: Array<{ name: string; passed: boolean; message?: string }> = [];
      let repoOk = false;
      let warehouseOk = false;

      try {
        await dbtRepo.syncRepo(tenantId);
        const models = await dbtRepo.listModels(tenantId);
        repoOk = true;
        checks.push({ name: "repo_sync", passed: true, message: `${models.length} models` });
      } catch (error) {
        checks.push({ name: "repo_sync", passed: false, message: (error as Error).message });
      }

      if (warehouseConfig) {
        try {
          const warehouse = buildWarehouseFromTenantConfig(warehouseConfig);
          const testQuery = warehouseConfig.provider === "bigquery"
            ? "SELECT 1 AS ok"
            : "SELECT 1 AS ok LIMIT 1";
          await warehouse.query(testQuery);
          warehouseOk = true;
          checks.push({ name: "warehouse_connect", passed: true });
        } catch (error) {
          checks.push({ name: "warehouse_connect", passed: false, message: (error as Error).message });
        }
      } else {
        checks.push({
          name: "warehouse_connect",
          passed: false,
          message: "Warehouse config missing."
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
        launchCommand: ready ? "npm run dev -- slack --profile default --port 3000" : undefined,
        message: ready
          ? "Tenant is ready. Start the Slack server with the command above."
          : "Resolve failed checks before go-live."
      });
    } catch (error) {
      res.status(500).json({ ready: false, error: (error as Error).message, checks: [] });
    }
  });

  return router;
}
