# Environment strategy (dev / sandbox / prod)

Este documento resume cómo operar ambientes separados para `agent-blue` sin mezclar datos ni credenciales.

## Matriz de ambientes

| Ambiente | Objetivo | Dominio | Env file | Compose file | Datos persistentes |
|---|---|---|---|---|---|
| `dev` | Desarrollo local rápido | `localhost` | `.env` | (sin compose obligatorio) | `data/` local |
| `sandbox` | Validación pre-prod / pruebas integradas | `sandbox.agent.blueprintdata.xyz` | `.env.sandbox` | `docker-compose.sandbox.yml` | `data-sandbox/` |
| `prod` | Operación real | `agent.blueprintdata.xyz` | `.env.deploy` | `docker-compose.yml` | `data/` en VPS prod |

## Principios de aislamiento

1. **Credenciales separadas por ambiente** (LLM, Slack, Telegram, warehouse).
2. **Persistencia separada** (`data-sandbox/` no se comparte con prod).
3. **Dominios separados** para evitar confusiones operativas.
4. **Deploy independiente** por ambiente (no usar mismo comando para sandbox y prod).

## Sandbox (ambiente bajo)

Referencia completa:

- [`docs/SANDBOX_ENVIRONMENT.md`](./SANDBOX_ENVIRONMENT.md)

Flujo corto:

```bash
cp .env.sandbox.example .env.sandbox
docker compose --env-file .env.sandbox -f docker-compose.sandbox.yml up -d --build
```

## Promoción recomendada

1. Desarrollo en feature branch.
2. CI de PR (`.github/workflows/ci.yml`).
3. Deploy manual a sandbox (`.github/workflows/deploy-sandbox.yml`).
4. QA funcional en sandbox (auth, tenant onboarding, repo refresh, Slack/Telegram).
5. Recién ahí merge + deploy a producción.

## Checklist mínima por release

- [ ] PR con checks en verde.
- [ ] Sandbox desplegado con la misma `ref` a promover.
- [ ] Login admin OK.
- [ ] Refresh de repo OK.
- [ ] Test de warehouse OK.
- [ ] Entrega por Slack/Telegram OK (si aplica).

## Riesgos comunes

- Reusar tokens de prod en sandbox.
- Compartir volumen de datos entre ambientes.
- Publicar sandbox en puertos 80/443 del mismo host de prod sin proxy externo.
- No versionar el procedimiento de deploy.
