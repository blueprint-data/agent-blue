# agent-blue

Analytics agent foundation for company questions over Snowflake + dbt metadata, with pluggable model providers and channel adapters.

## Why this structure

This repo is built around interfaces so you can swap:

- **LLM provider** (OpenRouter, Vercel AI Gateway, direct providers)
- **Channel transport** (CLI now, Slack/Web UI later)
- **Warehouse adapter** (Snowflake now, BigQuery next)
- **Memory store** (SQLite now, PostgreSQL later)

Core orchestration lives in one place (`AnalyticsAgentRuntime`) and depends on interfaces, not implementations.

## Current capabilities

- Tenant bootstrap process:
  - Generates and persists an **ed25519 deploy keypair**.
  - Stores tenant repo config in SQLite.
  - Prints the public key so users can add it as a GitHub Deploy Key.
- dbt repo integration:
  - Clone/pull using tenant deploy key.
  - List models and inspect model SQL files.
- Snowflake integration:
  - Executes read-only SQL through an adapter.
  - SQL guard to enforce SELECT/WITH-only and row limits.
- Conversation memory:
  - SQLite store for conversations/messages/profiles/repo config.
- Agent profile abstraction (“souls”):
  - Per-tenant profile with system prompt and query row limits.

## Project layout

```txt
src/
  core/                 # interfaces + runtime + sql guard
  adapters/
    llm/                # model provider adapters
    warehouse/          # snowflake/bigquery adapters
    dbt/                # git dbt repo service
    store/              # sqlite persistence
    channel/            # transport adapters
  bootstrap/            # tenant setup / key generation
  config/               # env config
  utils/                # shared helpers
```

## Quick start

1. Install deps

```bash
npm install
```

2. Configure env

```bash
cp .env.example .env
# then fill values
```

Snowflake auth can be either:

- `SNOWFLAKE_AUTH_TYPE=password` + `SNOWFLAKE_PASSWORD`
- `SNOWFLAKE_AUTH_TYPE=keypair` + `SNOWFLAKE_PRIVATE_KEY_PATH` (and optional `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`)

3. Initialize tenant + repo (creates keys and stores config)

```bash
npm run dev -- init --tenant acme --repo-url git@github.com:your-org/your-dbt.git --dbt-subpath models
```

4. Add printed public key to GitHub repo as Deploy Key (read-only is enough).

5. Sync dbt repo

```bash
npm run dev -- sync-dbt --tenant acme
```

6. Chat

```bash
npm run dev -- chat --tenant acme
```

One-shot chat:

```bash
npm run dev -- chat --tenant acme --message "How many orders did we have yesterday?"
```

## Commands

- `init`
  - `--tenant <id>`
  - `--repo-url <git@github.com:...>`
  - `--dbt-subpath <path>` (default: `models`)
  - `--force` (regenerate keypair)
- `sync-dbt`
  - `--tenant <id>`
- `prod-smoke`
  - `--tenant <id>`
- `chat`
  - `--tenant <id>`
  - `--profile <name>` (default: `default`)
  - `--conversation <id>` (optional)
  - `--message "<text>"` (optional, non-interactive)

## What you were missing (important for production)

1. **Authorization model**
   - Per-tenant isolation for keys, repo paths, warehouse credentials.
   - Per-agent profile ACLs (allowed dbt folders/models + max query scope).
2. **Guardrails beyond SQL read-only**
   - PII policies (masking/redaction rules).
   - Query cost/time budgets and cancellation.
   - Denylist/allowlist for schemas/tables.
3. **Prompt-injection defenses**
   - Treat dbt docs/SQL as untrusted input.
   - System-level tool rules must not be overridable by user/dbt content.
4. **Observability**
   - Structured logs for prompts/tool calls/query durations/errors.
   - Trace IDs per conversation turn.
5. **Evaluation harness**
   - Golden analytics questions + expected SQL/result characteristics.
   - Regression tests for planner decisions and SQL safety.
6. **Async execution model**
   - Some analytical queries are long-running; use job polling and partial updates in Slack/Web UI.
7. **Secrets and key management**
   - Move from local env vars/files to managed secrets/KMS for production.
8. **Schema/semantic abstraction**
   - Add semantic layer or curated metrics catalog so answers are stable and business-safe.
9. **Transport contracts**
   - Normalize message/thread semantics across Slack/Web to avoid agent logic leaks into channels.
10. **Versioned prompts (“souls”)**
   - Keep profile prompts versioned and auditable; allow safe rollout/rollback.

## Next recommended implementation steps

1. Add Slack adapter implementing `ChannelAdapter`.
2. Add HTTP API for web UI using the same runtime.
3. Add BigQuery adapter.
4. Add PostgreSQL store adapter.
5. Add policy engine:
   - table/schema allowlists
   - profile-specific model visibility
   - PII redaction pipeline
