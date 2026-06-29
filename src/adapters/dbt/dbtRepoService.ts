import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DbtRepositoryService, ConversationStore } from "../../core/interfaces.js";
import { DbtModelInfo } from "../../core/types.js";

interface CacheEntry<T> {
  data: T;
  ts: number;
}

function walkDir(startPath: string): string[] {
  const entries = fs.readdirSync(startPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(startPath, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "target", "node_modules", "dbt_packages"].includes(entry.name)) {
        continue;
      }
      files.push(...walkDir(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function inferRepoSlug(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\.git$/, "");
  const parts = cleaned.split(/[/:]/);
  return parts.slice(-2).join("-");
}

export class GitDbtRepositoryService implements DbtRepositoryService {
  private modelListCache = new Map<string, CacheEntry<DbtModelInfo[]>>();
  private modelSqlCache = new Map<string, CacheEntry<string | null>>();

  constructor(
    private readonly store: ConversationStore,
    private readonly modelCacheTtlMs: number = 300_000
  ) {}

  private clearTenantCache(tenantId: string): void {
    for (const key of this.modelListCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.modelListCache.delete(key);
      }
    }
    for (const key of this.modelSqlCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.modelSqlCache.delete(key);
      }
    }
  }

  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string, ttlMs: number): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > ttlMs) {
      cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  async syncRepo(tenantId: string): Promise<void> {
    const repo = this.store.getTenantRepo(tenantId);
    if (!repo) {
      throw new Error(`No dbt repo configured for tenant "${tenantId}". Run init first.`);
    }

    const deployKeyPath = path.resolve(repo.deployKeyPath);
    const localRepoPath = path.resolve(repo.localPath);
    const sshCommand = `ssh -i "${deployKeyPath}" -o StrictHostKeyChecking=accept-new`;
    const env = {
      ...process.env,
      GIT_SSH_COMMAND: sshCommand,
      // Ignore environment-level global git URL rewrites so deploy-key SSH is always used.
      GIT_CONFIG_GLOBAL: "/dev/null"
    };

    if (!fs.existsSync(localRepoPath)) {
      fs.mkdirSync(path.dirname(localRepoPath), { recursive: true });
      execFileSync("git", ["clone", repo.repoUrl, localRepoPath], { env, stdio: "pipe" });
      this.clearTenantCache(tenantId);
      return;
    }

    execFileSync("git", ["-C", localRepoPath, "pull", "--ff-only"], { env, stdio: "pipe" });
    this.clearTenantCache(tenantId);
  }

  async listModels(tenantId: string, dbtSubpath?: string): Promise<DbtModelInfo[]> {
    const cacheKey = `${tenantId}:${dbtSubpath ?? ""}`;
    const cached = this.getCached(this.modelListCache, cacheKey, this.modelCacheTtlMs);
    if (cached) return cached;

    const repo = this.store.getTenantRepo(tenantId);
    if (!repo) {
      return [];
    }
    const root = path.resolve(path.join(repo.localPath, dbtSubpath ?? repo.dbtSubpath));
    if (!fs.existsSync(root)) {
      return [];
    }
    const sqlFiles = walkDir(root).filter((f) => f.endsWith(".sql"));
    const models = sqlFiles.map((file) => ({
      name: path.basename(file, ".sql"),
      relativePath: path.relative(root, file)
    }));
    this.modelListCache.set(cacheKey, { data: models, ts: Date.now() });
    return models;
  }

  async getModelSql(tenantId: string, modelName: string, dbtSubpath?: string): Promise<string | null> {
    const cacheKey = `${tenantId}:${modelName}:${dbtSubpath ?? ""}`;
    const cached = this.getCached(this.modelSqlCache, cacheKey, this.modelCacheTtlMs);
    if (cached !== undefined) return cached;

    const repo = this.store.getTenantRepo(tenantId);
    if (!repo) {
      return null;
    }
    const root = path.resolve(path.join(repo.localPath, dbtSubpath ?? repo.dbtSubpath));
    if (!fs.existsSync(root)) {
      return null;
    }
    const sqlFiles = walkDir(root).filter((f) => f.endsWith(".sql"));
    const exact = sqlFiles.find((f) => path.basename(f, ".sql") === modelName);
    if (!exact) {
      this.modelSqlCache.set(cacheKey, { data: null, ts: Date.now() });
      return null;
    }
    const sql = fs.readFileSync(exact, "utf8");
    this.modelSqlCache.set(cacheKey, { data: sql, ts: Date.now() });
    return sql;
  }

  static buildLocalRepoPath(baseDir: string, tenantId: string, repoUrl: string): string {
    return path.join(baseDir, "repos", tenantId, inferRepoSlug(repoUrl));
  }
}
