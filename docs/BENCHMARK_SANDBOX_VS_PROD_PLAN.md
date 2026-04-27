# Benchmark plan refinado: Sandbox vs Prod (Agent Blue)

## 1) Resumen ejecutivo

Objetivo: comparar cambios de eficiencia/confiabilidad del agente en **sandbox** contra **producción** antes de promover a `main`.

Propuesta recomendada (estilo SaaS/PaaS, priorizando opciones sin costo):

1. **Gate pre-merge en PR** con benchmark reproducible.
2. **Persistencia histórica de resultados** (JSON + DB de benchmark).
3. **Reporte en comentario de PR + artifacts** (fuente de verdad técnica).
4. **Dashboard OSS** (Metabase/Grafana/Superset) según costo-operación.
5. **Canary/post-deploy** en etapa posterior.

> Nota: usar README como dashboard principal suena atractivo, pero en práctica genera ruido de commits y no escala bien como fuente operativa diaria.

> Nota clave: la **precisión** no la da el dashboard; la dan el diseño del experimento, el tamaño de muestra y la comparación estadística.

---

## 2) Estado actual del repo (hoy)

Ya existe harness base:

- `npm run dev -- e2e-loop --tenant <id> ...`
  - entrega métricas por turno/modelo:
    - `fallbackTurns`
    - `avgPlannerAttempts`
    - `avgTotalMs`
    - `snowflakeOk` / `snowflakeErrors`
- `npm run dev -- prod-smoke --tenant <id> ...`
  - valida conectividad (LLM / warehouse / dbt), **no** compara rendimiento entre ambientes.

También existe deploy de sandbox por GitHub Actions (`deploy-sandbox.yml`) con selección de servicios.

---

## 3) Qué problema queremos resolver

Evitar merges con “mejoras” que en realidad:

- suben latencia,
- aumentan fallbacks,
- introducen más errores de herramientas,
- o degradan estabilidad en producción.

---

## 4) Principios de medición (para que la comparación sea justa)

1. **Mismas condiciones** entre sandbox/prod:
   - mismo tenant de benchmark (o tenants espejados),
   - misma base/dataset lógico,
   - mismo `profile`,
   - mismo `model`,
   - mismo set de prompts.
2. **Múltiples corridas** (no 1 sola): mínimo `runs=5` (ideal `10`).
3. **Calcular distribución**, no solo promedio (mediana/p95 cuando aplique).
4. **Comparar por delta (%)** contra baseline, no por valor absoluto aislado.

---

## 5) Marco de métricas (v1)

## 5.1 Confiabilidad (CRÍTICAS)

- **fallbackRate** = `fallbackTurns / totalTurns`
- **toolErrorRate** = `snowflakeErrors / (snowflakeOk + snowflakeErrors)`
- **hardFailureRate** (si hay turnos con error no recuperable)

## 5.2 Eficiencia (ALTAS)

- **avgTotalMs** (promedio)
- **p95TotalMs** (agregar en v1.1)
- **avgPlannerAttempts**

## 5.3 Calidad de respuesta (MEDIAS, v1.1)

- score por pregunta en set de validación (rubrica simple 0/1 o 0/2)
- exactitud de agregados clave (cuando aplique)

## 5.4 Costo (MEDIAS, v1.1)

- tokens por turno
- costo estimado por turno exitoso

---

## 6) Umbrales iniciales de aceptación (propuestos)

Para permitir promoción sandbox -> prod:

- `fallbackRate` en sandbox **no empeora > 5% relativo** vs prod
- `toolErrorRate` en sandbox **<= prod** y objetivo ideal `0`
- `avgTotalMs` en sandbox **no empeora > 10%** vs prod
- `avgPlannerAttempts` en sandbox **no empeora > 10%**

Si falla cualquiera CRÍTICA, el cambio queda en estado **needs-investigation**.

---

## 7) Opciones evaluadas (gratis y pagas)

## Opción A — GitHub-only (PR comment + artifacts + Step Summary)

**Costo**: gratis (ya disponible).

- **Pros**:
  - implementación rápida,
  - auditable por run,
  - ideal para gate de PR.
- **Contras**:
  - histórico menos amigable para análisis de tendencia,
  - visualización limitada.

## Opción B — Metabase OSS + DB de benchmark (RECOMENDADA para dashboard sin costo)

**Costo**: gratis en self-hosted (costo de infraestructura propia).

Metabase soporta bases como **PostgreSQL** y **SQLite**, por lo que puede leer una tabla histórica de benchmarks sin pagar SaaS.

- **Pros**:
  - dashboard visual real (filtros por branch/model/env/fecha),
  - buena UX para producto/negocio,
  - cero licencia en modalidad OSS.
- **Contras**:
  - hay que operar un servicio adicional,
  - requiere pipeline de ingesta (workflow -> DB).

## Opción C — Grafana OSS + almacenamiento de métricas

**Costo**: gratis en self-hosted (costo de operación).

- **Pros**:
  - muy bueno para series temporales y alertas,
  - estándar SRE/operación.
- **Contras**:
  - mayor complejidad inicial que Metabase para equipos orientados a BI,
  - configuración más técnica para benchmark tabular.

## Opción D — Apache Superset OSS

**Costo**: gratis en self-hosted.

- **Pros**:
  - potente para SQL + dashboards,
  - flexible para análisis ad-hoc.
- **Contras**:
  - curva operativa y de configuración mayor,
  - más pesado para un MVP de benchmark.

## Opción E — SaaS pagos (Datadog/New Relic/etc.)

**Costo**: pago.

- **Pros**:
  - time-to-value alto en observabilidad avanzada,
  - alertas y ecosistema enterprise.
- **Contras**:
  - costo recurrente,
  - riesgo de lock-in.

### Matriz comparativa rápida

| Opción | Costo licencia | Automatización | Precisión técnica* | Complejidad operación | Recomendación |
|---|---|---|---|---|---|
| A. GitHub-only | Gratis | Alta | Media-Alta | Baja | ✅ Base v1 |
| B. Metabase OSS | Gratis (self-hosted) | Alta | Media-Alta | Media | ✅ Dashboard v1.1 |
| C. Grafana OSS | Gratis (self-hosted) | Alta | Alta | Media-Alta | ◻️ v2 (SRE) |
| D. Superset OSS | Gratis (self-hosted) | Media-Alta | Media-Alta | Alta | ◻️ opcional |
| E. SaaS pagos | Pago | Alta | Alta | Baja-Media | ◻️ cuando haya presupuesto |

\* La precisión depende principalmente del método de benchmark (muestras, baseline, estadística), no de la herramienta de visualización.

### Decisión propuesta

- v1: **A** (gate técnico serio con PR comment + artifacts)
- v1.1: **A + B** (agregar dashboard en Metabase OSS)
- v2: **C** o **E** para observabilidad continua/canary según presupuesto y madurez

---

## 8) Arquitectura de benchmark propuesta (v1)

1. **Scenario catalog** (prompts versionados)
   - archivo JSON/MD con escenarios de negocio (golden set).
2. **Runner**
   - usa `e2e-loop` con parámetros controlados.
3. **Extractor**
   - convierte salida a JSON estructurado por run/model/env.
4. **Comparator**
   - calcula deltas sandbox vs prod y evalúa thresholds.
5. **Reporter**
   - publica tabla markdown en PR + sube artifact JSON.
6. **Store histórico (v1.1)**
   - persiste resultados en DB de benchmark (Postgres recomendado; SQLite posible).
7. **Dashboard OSS (v1.1)**
   - visualización en Metabase sobre la DB histórica.

---

## 9) Plan por fases (implementación)

## Fase 0 — Alineación (rápida)

- Definir set de 8–15 prompts “golden”.
- Confirmar tenant/dataset de benchmark (prod y sandbox).
- Acordar thresholds v1.

**Salida:** contrato de medición cerrado.

Referencia de contrato local-first (etapa 0):

- `docs/BENCHMARK_LOCAL_CONTRACT.md`

## Fase 1 — Benchmark reproducible local/CI

- Script para ejecutar harness por ambiente con inputs fijos.
- Export JSON por corrida (`benchmark-result.json`).
- Script comparador que emite:
  - tabla markdown,
  - pass/fail por métrica,
  - diagnóstico corto.

**Salida:** comparación automática offline.

## Fase 2 — Workflow GitHub (`benchmark-compare.yml`)

- `workflow_dispatch` inicial.
- Inputs:
  - `ref`
  - `tenant`
  - `model`
  - `runs`
  - `prompts`
- Ejecuta sandbox + prod, sube artifacts, comenta en PR (si aplica).

**Salida:** reporte estándar por ejecución.

## Fase 3 — Persistencia histórica + dashboard OSS (Metabase)

- Crear tabla(s) `benchmark_runs` y `benchmark_metrics`.
- Workflow inserta resultados por ejecución.
- Metabase conectado a esa DB con dashboards de tendencia.

**Salida:** tablero histórico sin costo de licencia.

## Fase 4 — Gate de promoción

- Integrar resultado al proceso de release:
  - si `fail` -> no promover
  - si `pass` -> habilitar deploy

**Salida:** control de calidad objetivo antes de producción.

## Fase 5 — Canary + observabilidad (v2)

- envío parcial/controlled traffic
- métricas online (p50/p95/error/fallback)
- alertas y rollback playbook

**Salida:** madurez operativa estilo SaaS/PaaS.

---

## 10) Flujo operativo recomendado (día a día)

1. Deploy branch a sandbox.
2. Correr benchmark comparativo (sandbox vs prod).
3. Revisar reporte en PR:
   - deltas,
   - semáforo pass/fail,
   - comentarios de riesgo.
4. Decidir:
   - **Promover**,
   - **Ajustar y repetir**,
   - **Descartar cambio**.

---

## 11) Riesgos y mitigaciones

- **Ruido por variabilidad LLM**
  - Mitigación: más runs + percentiles + mismas condiciones.
- **Comparación injusta por datasets distintos**
  - Mitigación: tenant de benchmark estable y sincronizado.
- **Métrica incompleta (solo latencia/fallback)**
  - Mitigación: agregar calidad/costo en v1.1.
- **Confundir smoke check con benchmark**
  - Mitigación: separar claramente `prod-smoke` (salud) de benchmark (rendimiento/calidad).

---

## 12) Preguntas abiertas para cerrar con el equipo

1. ¿Cuál será el prompt set oficial (y quién lo versiona)?
2. ¿Qué umbrales finales aprobamos por métrica?
3. ¿Se gatea en PR o en paso previo al deploy?
4. ¿Qué DB vamos a usar para histórico (`Postgres` recomendado vs `SQLite`)?
5. ¿Cuándo pasamos de Metabase OSS a observabilidad externa (si hace falta)?

---

## 13) Decisión propuesta para esta semana

Implementar **v1 (GitHub-only: PR comment + artifacts + gate)** con thresholds iniciales y set golden básico.

En paralelo, preparar **v1.1 con Metabase OSS** sobre DB histórica para tener dashboard real sin costo de licencia.

Es la mejor relación **impacto / complejidad** para el momento actual del proyecto.
