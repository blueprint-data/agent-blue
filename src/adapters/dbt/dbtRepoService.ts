import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DbtRepositoryService, ConversationStore } from "../../core/interfaces.js";
import { DbtModelInfo } from "../../core/types.js";

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
  constructor(private readonly store: ConversationStore) {}

  async syncRepo(tenantId: string): Promise<void> {
    const repo = this.store.getTenantRepo(tenantId);
    if (!repo) {
      throw new Error(`No dbt repo configured for tenant "${tenantId}". Run init first.`);
    }

    const sshCommand = `ssh -i "${repo.deployKeyPath}" -o StrictHostKeyChecking=accept-new`;
    const env = {
      ...process.env,
      GIT_SSH_COMMAND: sshCommand,
      // Ignore environment-level global git URL rewrites so deploy-key SSH is always used.
      GIT_CONFIG_GLOBAL: "/dev/null"
    };

    if (!fs.existsSync(repo.localPath)) {
      fs.mkdirSync(path.dirname(repo.localPath), { recursive: true });
      execFileSync("git", ["clone", repo.repoUrl, repo.localPath], { env, stdio: "pipe" });
      return;
    }

    execFileSync("git", ["-C", repo.localPath, "pull", "--ff-only"], { env, stdio: "pipe" });
  }

  async listModels(tenantId: string, dbtSubpath?: string): Promise<DbtModelInfo[]> {
    const repo = this.store.getTenantRepo(tenantId);
    if (!repo) {
      return [];
    }
    const root = path.join(repo.localPath, dbtSubpath ?? repo.dbtSubpath);
    if (!fs.existsSync(root)) {
      return [];
    }
    const sqlFiles = walkDir(root).filter((f) => f.endsWith(".sql"));
    return sqlFiles.map((file) => ({
      name: path.basename(file, ".sql"),
      relativePath: path.relative(root, file)
    }));
  }

  async getModelSql(tenantId: string, modelName: string, dbtSubpath?: string): Promise<string | null> {
    const repo = this.store.getTenantRepo(tenantId);
    if (!repo) {
      return null;
    }
    const root = path.join(repo.localPath, dbtSubpath ?? repo.dbtSubpath);
    if (!fs.existsSync(root)) {
      return null;
    }
    const sqlFiles = walkDir(root).filter((f) => f.endsWith(".sql"));
    const exact = sqlFiles.find((f) => path.basename(f, ".sql") === modelName);
    if (!exact) {
      return null;
    }
    return fs.readFileSync(exact, "utf8");
  }

  static buildLocalRepoPath(baseDir: string, tenantId: string, repoUrl: string): string {
    return path.join(baseDir, "repos", tenantId, inferRepoSlug(repoUrl));
  }
}
