# Repo Refresh Integration (token-authenticated)

This guide explains how to trigger Agent Blue dbt repo refresh from an external CI/CD pipeline (for example, right after `dbt docs` in a separate data-stack repository).

## Why this integration exists

- Keep Agent Blue in sync with the latest dbt project state.
- Trigger refresh exactly when your data pipeline updates docs/artifacts.
- Use least-privilege auth: tenant-scoped integration token (not global admin token).

## Endpoint contract

- **Method**: `POST`
- **Path (recommended)**: `/api/integrations/repo-refresh`
- **Path (legacy compatible)**: `/api/integrations/tenants/:tenantId/repo-refresh`
- **Auth**: `Authorization: Bearer <integration_token>`

Example:

```bash
curl -X POST \
  -H "Authorization: Bearer ${AGENT_BLUE_REFRESH_TOKEN}" \
  "${AGENT_BLUE_URL}/api/integrations/repo-refresh"
```

Legacy example (still supported):

```bash
curl -X POST \
  -H "Authorization: Bearer ${AGENT_BLUE_REFRESH_TOKEN}" \
  "${AGENT_BLUE_URL}/api/integrations/tenants/${TENANT_ID}/repo-refresh"
```

## Generate token in Admin UI

1. Go to **Tenants**.
2. Select the target tenant.
3. Open **Integration tokens (repo refresh)**.
4. Click **Generate token**.
5. Copy and store the token immediately.

Important behavior:

- Plaintext token is returned only at creation time.
- UI auto-hides token after 60 seconds.
- UI also hides token immediately after successful copy.
- Stored token list shows metadata only (never plaintext secret).

## Store in external repository secrets

In your data-stack repository (GitHub), add secrets:

- `AGENT_BLUE_URL` (example: `https://agent.blueprintdata.xyz`)
- `AGENT_BLUE_REFRESH_TOKEN`

`TENANT_ID` is no longer required when using the recommended endpoint.

## GitHub Action step (recommended)

Use this step after your `dbt docs` step:

```bash
set -euo pipefail

body="$(mktemp)"
code="$(curl -sS -o "$body" -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer ${AGENT_BLUE_REFRESH_TOKEN}" \
  "${AGENT_BLUE_URL}/api/integrations/repo-refresh")"

# 200 = refreshed, 409 = already in progress (non-fatal)
if [[ "$code" == "200" || "$code" == "409" ]]; then
  cat "$body"
  exit 0
fi

cat "$body"
exit 1
```

## HTTP status semantics

- `200`: refresh executed successfully.
- `409`: refresh already in progress (`repo_refresh_in_progress`) — safe operationally.
- `401`: invalid, revoked, malformed, or unauthorized integration token.
- `404`: tenant does not exist.
- `500`: real refresh failure (repo/deploy key access, git failure, etc.).

## Security recommendations

- Use one token per tenant/integration consumer.
- Revoke and rotate immediately if token is exposed.
- Prefer short rotation windows (for example, 60–90 days).
- Never paste plaintext tokens in tickets/chat/logs.
- Use `401`/`403` monitoring as potential misuse signal.

## Troubleshooting

### `Cannot GET /api/admin/tenants/:tenantId/integration-tokens`

Usually indicates an old backend process/build still running.

- Restart Admin API process/container.
- Confirm branch with integration-token routes is deployed.

### `401 Unauthorized integration token`

- Token revoked or malformed.
- Wrong value in CI secret.
- Legacy path only: `TENANT_ID` does not match the token tenant.

### `500` with git/deploy-key error

- Deploy key missing in repo or wrong permissions.
- Repo URL changed.
- Host key/network issue.
