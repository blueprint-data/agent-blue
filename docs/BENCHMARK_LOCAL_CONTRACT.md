# Benchmark local-first: contrato de medición (Etapa 0)

## Estado

- **Versión:** v0.1
- **Etapa:** 0 (contrato de medición)
- **Objetivo de esta etapa:** cerrar QUÉ medimos, CÓMO lo calculamos y BAJO QUÉ condiciones.

---

## 1) Objetivo

Definir un benchmark **local, reproducible y comparable** para evaluar iteraciones del harness y modelos LLM con foco en:

- tiempo total,
- loops (planner attempts),
- tokens,
- costo,
- y señales mínimas de confiabilidad.

Este documento es el contrato base antes de implementar export JSON, comparador y dashboard.

---

## 2) Alcance v1 (local-first)

Incluye:

- ejecución local con `e2e-loop`,
- recolección estandarizada por turno y por corrida,
- comparación **baseline vs candidate** en la misma máquina/entorno.

No incluye todavía:

- gate en CI,
- comparación multi-host automática,
- dashboard productivo compartido.

---

## 3) Condiciones de corrida (control experimental)

Para que la comparación tenga sentido, se exige:

1. **Mismo tenant de benchmark** (o dataset lógico equivalente).
2. **Mismo profile**.
3. **Mismo prompt set versionado**.
4. **Mismo número de runs** por modelo.
5. **Misma máquina y configuración local** durante baseline/candidate.
6. **Sin cambios de credenciales o warehouse entre corridas comparadas**.

Recomendaciones operativas:

- usar un `APP_DATA_DIR` dedicado para benchmark (evita ruido con data de uso diario),
- mínimo `runs=5` para exploración; ideal `runs=10` para comparar decisiones.

---

## 4) Prompt set oficial (v1)

**Prompt set id:** `e2e-default-v1`

Archivo fuente (versionado):

- `benchmark/prompts/e2e-default-v1.json`

Preguntas actuales del harness (`src/index.ts`):

1. `How many users do we have in total?`
2. `How many were created last month?`
3. `From those, how many made a transaction since?`
4. `Can you provide a bar chart by signup month for the last 6 months and summarize the trend?`

Regla: si cambia el contenido/orden de prompts, se debe versionar (`e2e-default-v2`, etc.).

---

## 5) Métricas oficiales v1

## 5.1 Nivel turno (unit of analysis)

| Métrica | Tipo | Fuente | Fórmula / extracción |
|---|---|---|---|
| `total_time_ms` | número | `response.debug.timings.totalMs` | valor numérico o `null` |
| `loops` | entero | `response.debug.plannerAttempts` | `length(plannerAttempts)` |
| `fallback` | boolean | texto respuesta | `text.includes("I could not reach a reliable final answer")` |
| `warehouse_query_ok` | entero | `response.debug.toolCalls` | conteo `tool=="warehouse.query" && status=="ok"` |
| `warehouse_query_error` | entero | `response.debug.toolCalls` | conteo `tool=="warehouse.query" && status=="error"` |
| `prompt_tokens` | entero | `response.debug.llmUsage.totals` | `promptTokens` |
| `completion_tokens` | entero | `response.debug.llmUsage.totals` | `completionTokens` |
| `total_tokens` | entero | `response.debug.llmUsage.totals` | `totalTokens` |
| `total_cost` | número | `response.debug.llmUsage.totals` | `totalCost` |
| `llm_calls` | entero | `response.debug.llmUsage.calls` | `length(calls)` |

## 5.2 Nivel corrida/modelo (agregados)

Para `N = total_turns`:

- `fallback_rate = fallback_turns / N`
- `tool_error_rate = sum(warehouse_query_error) / (sum(warehouse_query_ok) + sum(warehouse_query_error))`
- `avg_total_time_ms = avg(total_time_ms)`
- `median_total_time_ms = p50(total_time_ms)`
- `p95_total_time_ms = p95(total_time_ms)`
- `avg_loops = avg(loops)`
- `median_loops = p50(loops)`
- `total_prompt_tokens = sum(prompt_tokens)`
- `total_completion_tokens = sum(completion_tokens)`
- `total_tokens = sum(total_tokens)`
- `total_cost = sum(total_cost)`
- `cost_per_turn = total_cost / N`
- `tokens_per_turn = total_tokens / N`

Si el denominador de `tool_error_rate` es `0`, reportar `0` y marcar `no_warehouse_calls=true`.

---

## 6) Esquema mínimo de resultado (JSON target)

```json
{
  "benchmarkVersion": "v1",
  "promptsId": "e2e-default-v1",
  "runMeta": {
    "runId": "bench_2026-04-27T23-59-00Z",
    "branch": "feat/benchmark-local-harness",
    "commit": "<sha>",
    "tenantId": "acme",
    "profileName": "default",
    "runs": 10,
    "executedAt": "2026-04-27T23:59:00Z"
  },
  "models": [
    {
      "model": "openai/gpt-4o-mini",
      "turns": [
        {
          "runIndex": 1,
          "questionIndex": 1,
          "question": "How many users do we have in total?",
          "metrics": {
            "totalTimeMs": 1234,
            "loops": 2,
            "fallback": false,
            "warehouseQueryOk": 1,
            "warehouseQueryError": 0,
            "promptTokens": 321,
            "completionTokens": 78,
            "totalTokens": 399,
            "totalCost": 0.0012,
            "llmCalls": 3
          }
        }
      ],
      "summary": {
        "fallbackRate": 0.05,
        "toolErrorRate": 0.0,
        "avgTotalTimeMs": 1100,
        "medianTotalTimeMs": 980,
        "p95TotalTimeMs": 2200,
        "avgLoops": 1.8,
        "totalTokens": 18200,
        "totalCost": 0.085
      }
    }
  ]
}
```

---

## 7) Reglas de comparación local (baseline vs candidate)

1. Baseline y candidate se corren con el mismo contrato (secciones 3 y 4).
2. Se comparan por modelo con deltas relativos (%).
3. Se reportan al menos:
   - `delta_median_total_time_ms_%`,
   - `delta_avg_loops_%`,
   - `delta_total_tokens_%`,
   - `delta_total_cost_%`,
   - `delta_fallback_rate_pp`.

**Modo exploración (v1 inicial):** sin fail automático, pero con semáforo `better/similar/worse`.

---

## 8) Umbrales iniciales sugeridos (para fase gate futura)

Estos umbrales no bloquean aún en Etapa 0, pero quedan definidos para etapas siguientes:

- `fallback_rate`: no empeorar > 5% relativo.
- `tool_error_rate`: no empeorar; objetivo ideal `0`.
- `median_total_time_ms`: no empeorar > 10%.
- `avg_loops`: no empeorar > 10%.
- `total_cost`: no empeorar > 15% (salvo justificación por mejora clara de calidad).

---

## 9) Hallazgos técnicos a corregir en Etapa 1

1. `e2e-loop` hoy resume `snowflakeOk/snowflakeErrors` buscando `tool == "snowflake.query"`,
   pero runtime registra `tool == "warehouse.query"`.
2. `e2e-loop` imprime métricas por consola, pero no exporta JSON estructurado.
3. El debug ya incluye `llmUsage` (tokens/costo), pero el parser actual no lo consume para summary.

Estos puntos son parte del trabajo de implementación en la próxima etapa.

---

## 10) Criterios de aceptación de Etapa 0

Etapa 0 se considera completa cuando:

- [x] existe contrato escrito con métricas, fórmulas y fuentes,
- [x] existe prompt set oficial versionado,
- [x] existe esquema JSON objetivo,
- [x] se documentan gaps técnicos concretos para Etapa 1,
- [x] el equipo puede revisar y acordar sin ambigüedad.
