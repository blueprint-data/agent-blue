# Sandbox environment (ambiente bajo)

Este documento define una forma simple y segura de operar un entorno sandbox separado de producción.

## Objetivo

- Aislar configuración, credenciales y datos de producción.
- Probar cambios funcionales con URL pública propia.
- Mantener un camino de deploy repetible desde GitHub Actions.

## Archivos nuevos de sandbox

- `docker-compose.sandbox.yml`
- `Caddyfile.sandbox`
- `.env.sandbox.example`
- `.github/workflows/deploy-sandbox.yml`

## Recomendación de infraestructura

**Recomendado:** VPS separado para sandbox.

Si compartís host con producción, debés cambiar puertos (`SANDBOX_HTTP_PORT` / `SANDBOX_HTTPS_PORT`) y poner un proxy externo que enrute al stack sandbox.

## Bootstrap rápido (manual)

1. En el host sandbox:

```bash
mkdir -p /srv/agent-blue-sandbox
cd /srv/agent-blue-sandbox
git clone https://github.com/blueprint-data/agent-blue.git .
cp .env.sandbox.example .env.sandbox
```

2. Editar `.env.sandbox` y completar al menos:

- `SANDBOX_DOMAIN`
- `LLM_API_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- tokens de Slack/Telegram sandbox (si aplica)

3. Levantar stack sandbox:

```bash
docker compose --env-file .env.sandbox -f docker-compose.sandbox.yml up -d --build
```

## Atajo local (más rápido)

Si ya tenés un `.env` operativo, podés reutilizarlo para una prueba local rápida sin crear `.env.sandbox`:

```bash
npm run sandbox:local
```

Luego abrir: `https://localhost:8443/admin/`.
Si necesitás Telegram en este modo, agregá `telegram` al comando y asegurate de tener `TELEGRAM_BOT_TOKEN`.
Para bajar el stack local: `npm run sandbox:local:down`.

## Deploy desde GitHub Actions

Workflow: `.github/workflows/deploy-sandbox.yml` (manual con `workflow_dispatch`).

Configurar en GitHub:

### Secrets

- `SANDBOX_SSH_HOST`
- `SANDBOX_SSH_USER`
- `SANDBOX_SSH_KEY`

### Variables (Repository/Environment vars)

- `SANDBOX_APP_DIR` (ej: `/srv/agent-blue-sandbox`)
- `SANDBOX_SSH_PORT` (opcional, default `22`)

Luego ejecutar la action **Deploy Sandbox** y opcionalmente indicar:

- `ref` (branch/tag/SHA)
- `services`:
  - `proxy admin slack` (default)
  - `proxy admin slack telegram` (si querés incluir Telegram)

## Aislamiento mínimo recomendado

- Workspace/app de Slack independiente para sandbox.
- Dataset/schema de warehouse no productivo.
- `data-sandbox/` separado de `data/`.
- Subdominio dedicado (`sandbox.agent.blueprintdata.xyz`).
