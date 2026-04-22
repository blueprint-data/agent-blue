import type { DbtRepositoryService } from "../../../core/interfaces.js";

export class TenantRepoRefreshInProgressError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super(`Repo refresh already in progress for tenant \"${tenantId}\".`);
    this.name = "TenantRepoRefreshInProgressError";
    this.tenantId = tenantId;
  }
}

export async function runTenantRepoRefresh(input: {
  tenantId: string;
  dbtRepo: DbtRepositoryService;
  locks: Set<string>;
}): Promise<{ modelCount: number; refreshedAt: string; message: string }> {
  const { tenantId, dbtRepo, locks } = input;
  if (locks.has(tenantId)) {
    throw new TenantRepoRefreshInProgressError(tenantId);
  }

  locks.add(tenantId);
  try {
    await dbtRepo.syncRepo(tenantId);
    const models = await dbtRepo.listModels(tenantId);
    const refreshedAt = new Date().toISOString();
    return {
      modelCount: models.length,
      refreshedAt,
      message: `Repo refreshed. ${models.length} dbt models found.`
    };
  } finally {
    locks.delete(tenantId);
  }
}
