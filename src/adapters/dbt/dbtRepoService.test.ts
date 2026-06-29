import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitDbtRepositoryService } from "./dbtRepoService.js";
import type { ConversationStore } from "../../core/interfaces.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  }
});

function createRepoDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-blue-dbt-test-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, "models", "marts"), { recursive: true });
  return root;
}

/** Minimal store that only answers getTenantRepo — the only method the adapter touches. */
function storeFor(localPath: string, dbtSubpath = ""): ConversationStore {
  return {
    getTenantRepo() {
      return {
        repoUrl: "git@example.com:acme/dbt.git",
        localPath,
        dbtSubpath,
        deployKeyPath: "/dev/null"
      };
    }
  } as unknown as ConversationStore;
}

describe("GitDbtRepositoryService.getModelDocs", () => {
  it("parses model descriptions and columns from dbt schema YAML", async () => {
    const root = createRepoDir();
    fs.writeFileSync(
      path.join(root, "models", "marts", "schema.yml"),
      [
        "version: 2",
        "models:",
        "  - name: fct_transactions",
        "    description: Confirmed transactions",
        "    columns:",
        "      - name: user_id",
        "        description: User identifier",
        "      - name: amount",
        "  - name: dim_users",
        "    columns:",
        "      - name: user_id",
        "      - name: country"
      ].join("\n")
    );

    const service = new GitDbtRepositoryService(storeFor(root));
    const docs = await service.getModelDocs("acme");

    const byName = new Map(docs.map((d) => [d.name, d]));
    expect(byName.get("fct_transactions")).toEqual({
      name: "fct_transactions",
      description: "Confirmed transactions",
      columns: [
        { name: "user_id", description: "User identifier" },
        { name: "amount" }
      ]
    });
    expect(byName.get("dim_users")?.columns.map((c) => c.name)).toEqual(["user_id", "country"]);
  });

  it("supports the .yaml extension and merges multiple schema files", async () => {
    const root = createRepoDir();
    fs.writeFileSync(
      path.join(root, "models", "marts", "a.yaml"),
      ["version: 2", "models:", "  - name: model_a", "    columns:", "      - name: col_a"].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "models", "b.yml"),
      ["version: 2", "models:", "  - name: model_b", "    columns:", "      - name: col_b"].join("\n")
    );

    const service = new GitDbtRepositoryService(storeFor(root));
    const names = (await service.getModelDocs("acme")).map((d) => d.name).sort();

    expect(names).toEqual(["model_a", "model_b"]);
  });

  it("returns an empty array when no YAML docs exist", async () => {
    const root = createRepoDir();
    fs.writeFileSync(path.join(root, "models", "marts", "fct_transactions.sql"), "select 1");

    const service = new GitDbtRepositoryService(storeFor(root));
    expect(await service.getModelDocs("acme")).toEqual([]);
  });

  it("ignores malformed YAML files without throwing", async () => {
    const root = createRepoDir();
    fs.writeFileSync(path.join(root, "models", "marts", "broken.yml"), "models: [ : : not valid");
    fs.writeFileSync(
      path.join(root, "models", "marts", "good.yml"),
      ["version: 2", "models:", "  - name: ok_model", "    columns:", "      - name: id"].join("\n")
    );

    const service = new GitDbtRepositoryService(storeFor(root));
    const names = (await service.getModelDocs("acme")).map((d) => d.name);

    expect(names).toEqual(["ok_model"]);
  });

  it("caches results within the TTL", async () => {
    const root = createRepoDir();
    const schemaPath = path.join(root, "models", "marts", "schema.yml");
    fs.writeFileSync(
      schemaPath,
      ["version: 2", "models:", "  - name: cached_model", "    columns:", "      - name: id"].join("\n")
    );

    const service = new GitDbtRepositoryService(storeFor(root));
    const first = await service.getModelDocs("acme");
    expect(first.map((d) => d.name)).toEqual(["cached_model"]);

    // Mutate the filesystem; within TTL the cached value must still be returned.
    fs.rmSync(schemaPath);
    const second = await service.getModelDocs("acme");
    expect(second.map((d) => d.name)).toEqual(["cached_model"]);
  });

  it("re-reads after the TTL expires", async () => {
    const root = createRepoDir();
    const schemaPath = path.join(root, "models", "marts", "schema.yml");
    fs.writeFileSync(
      schemaPath,
      ["version: 2", "models:", "  - name: stale_model", "    columns:", "      - name: id"].join("\n")
    );

    // ttl of -1 means every cached entry is already past its TTL → always re-read.
    const service = new GitDbtRepositoryService(storeFor(root), -1);
    expect((await service.getModelDocs("acme")).map((d) => d.name)).toEqual(["stale_model"]);

    fs.rmSync(schemaPath);
    expect(await service.getModelDocs("acme")).toEqual([]);
  });
});
