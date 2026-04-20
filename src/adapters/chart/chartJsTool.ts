import type { ChartConfiguration, ChartType } from "chart.js";
import { ChartBuildResult, ChartBuildRequest, ChartTool } from "../../core/interfaces.js";
import { QueryResult } from "../../core/types.js";

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function pickFirstNumericColumn(result: QueryResult): string | null {
  for (const column of result.columns) {
    for (const row of result.rows) {
      if (asFiniteNumber(row[column]) !== null) {
        return column;
      }
    }
  }
  return null;
}

function pickFirstTextColumn(result: QueryResult, exclude: Set<string>): string | null {
  for (const column of result.columns) {
    if (exclude.has(column)) {
      continue;
    }
    for (const row of result.rows) {
      const value = row[column];
      if (value !== null && value !== undefined) {
        return column;
      }
    }
  }
  return null;
}

function toLabel(value: unknown): string {
  if (value === null || value === undefined) {
    return "(null)";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const isoDateTimeMatch = trimmed.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/
    );
    if (isoDateTimeMatch) {
      const year = isoDateTimeMatch[1];
      const month = isoDateTimeMatch[2];
      const day = isoDateTimeMatch[3];
      const hour = isoDateTimeMatch[4];
      const minute = isoDateTimeMatch[5];
      const second = isoDateTimeMatch[6];
      const hasTime = typeof hour === "string";
      const isMidnight =
        !hasTime || ((hour ?? "00") === "00" && (minute ?? "00") === "00" && (second ?? "00") === "00");

      // Prefer compact period labels for time buckets (e.g. month-level series).
      if (day === "01" && isMidnight) {
        return `${year}-${month}`;
      }
      return `${year}-${month}-${day}`;
    }
  }
  return String(value);
}

function sortedIndices(labels: string[], values: number[], sort: string | undefined): number[] {
  const indices = labels.map((_, idx) => idx);
  if (!sort || sort === "none") {
    return indices;
  }
  if (sort === "label_asc") {
    return indices.sort((a, b) => labels[a].localeCompare(labels[b]));
  }
  if (sort === "label_desc") {
    return indices.sort((a, b) => labels[b].localeCompare(labels[a]));
  }
  if (sort === "asc") {
    return indices.sort((a, b) => values[a] - values[b]);
  }
  if (sort === "desc") {
    return indices.sort((a, b) => values[b] - values[a]);
  }
  return indices;
}

function reorderByIndices<T>(items: T[], indices: number[]): T[] {
  return indices.map((idx) => items[idx]);
}

function resolveColumnName(result: QueryResult, requested: string | null | undefined): string | null {
  if (!requested) {
    return null;
  }
  if (result.columns.includes(requested)) {
    return requested;
  }
  const lowered = requested.toLowerCase();
  const match = result.columns.find((column) => column.toLowerCase() === lowered);
  return match ?? null;
}

export class ChartJsTool implements ChartTool {
  buildFromQueryResult(input: {
    request: ChartBuildRequest;
    result: QueryResult;
    maxPoints: number;
  }): ChartBuildResult {
    const requestedType = input.request.type ?? "bar";
    const type: ChartType =
      requestedType === "line" || requestedType === "pie" || requestedType === "doughnut" ? requestedType : "bar";
    const limit = Math.max(1, Math.min(input.request.maxPoints ?? input.maxPoints, input.maxPoints));
    const rows = input.result.rows.slice(0, limit);
    const requestedYKey = input.request.yKey ?? pickFirstNumericColumn(input.result);
    const yKey = resolveColumnName(input.result, requestedYKey);
    const requestedXKey =
      input.request.xKey ??
      pickFirstTextColumn(input.result, new Set(yKey ? [yKey] : [])) ??
      input.result.columns[0] ??
      null;
    const xKey = resolveColumnName(input.result, requestedXKey);
    const seriesKey = input.request.seriesKey ? resolveColumnName(input.result, input.request.seriesKey) : null;
    const explicitYKey = input.request.yKey ? resolveColumnName(input.result, input.request.yKey) : null;
    const explicitXKey = input.request.xKey ? resolveColumnName(input.result, input.request.xKey) : null;

    if (input.request.yKey && !explicitYKey) {
      throw new Error(
        `chartRequest.yKey "${input.request.yKey}" was not found in query columns: ${input.result.columns.join(", ")}`
      );
    }
    if (input.request.xKey && !explicitXKey) {
      throw new Error(
        `chartRequest.xKey "${input.request.xKey}" was not found in query columns: ${input.result.columns.join(", ")}`
      );
    }
    if (input.request.seriesKey && !seriesKey) {
      throw new Error(
        `chartRequest.seriesKey "${input.request.seriesKey}" was not found in query columns: ${input.result.columns.join(", ")}`
      );
    }
    if (!xKey) {
      throw new Error("Could not infer chart xKey from query result. Provide chartRequest.xKey.");
    }
    if (!yKey) {
      throw new Error("Could not infer chart yKey from query result. Provide chartRequest.yKey.");
    }

    const labels: string[] = [];
    const labelsSeen = new Set<string>();
    const datasetMap = new Map<string, Map<string, number>>();

    for (const row of rows) {
      const label = toLabel(row[xKey]);
      if (!labelsSeen.has(label)) {
        labelsSeen.add(label);
        labels.push(label);
      }
      const seriesName = seriesKey ? toLabel(row[seriesKey]) : (input.request.title ?? yKey);
      const value = asFiniteNumber(row[yKey]);
      if (value === null) {
        continue;
      }
      if (!datasetMap.has(seriesName)) {
        datasetMap.set(seriesName, new Map<string, number>());
      }
      const pointMap = datasetMap.get(seriesName) as Map<string, number>;
      pointMap.set(label, (pointMap.get(label) ?? 0) + value);
    }

    const rawDatasets = Array.from(datasetMap.entries()).map(([name, pointMap]) => ({
      label: name,
      data: labels.map((label) => pointMap.get(label) ?? 0),
      ...(input.request.stacked ? { stack: input.request.stackId ?? "stack-0" } : {})
    }));

    if (rawDatasets.length === 0) {
      throw new Error("No numeric datapoints found for chart. Verify yKey and query result.");
    }
    const firstDatasetValues = rawDatasets[0].data as number[];
    const order = sortedIndices(labels, firstDatasetValues, input.request.sort);
    let finalLabels = reorderByIndices(labels, order);
    let datasets = rawDatasets.map((dataset) => ({
      ...dataset,
      data: reorderByIndices(dataset.data as number[], order)
    }));

    if ((type === "pie" || type === "doughnut") && input.request.topN && input.request.topN < finalLabels.length) {
      const keep = Math.max(1, input.request.topN);
      const otherLabel = input.request.otherLabel?.trim() || "Other";
      const keptLabels = finalLabels.slice(0, keep);
      const remainingLabels = finalLabels.slice(keep);
      finalLabels = remainingLabels.length > 0 ? [...keptLabels, otherLabel] : keptLabels;
      datasets = datasets.map((dataset) => {
        const values = dataset.data as number[];
        const keptValues = values.slice(0, keep);
        const otherValue = values.slice(keep).reduce((sum, value) => sum + value, 0);
        const nextData = remainingLabels.length > 0 ? [...keptValues, otherValue] : keptValues;
        return { ...dataset, data: nextData };
      });
    }

    if (type === "bar" && input.request.percentStacked) {
      for (let idx = 0; idx < finalLabels.length; idx += 1) {
        const total = datasets.reduce((sum, dataset) => sum + Number((dataset.data as number[])[idx] ?? 0), 0);
        for (const dataset of datasets) {
          const values = dataset.data as number[];
          values[idx] = total === 0 ? 0 : (Number(values[idx] ?? 0) / total) * 100;
        }
      }
    }

    if (type === "bar" && typeof input.request.grouped === "boolean") {
      datasets = datasets.map((dataset) => ({ ...dataset, grouped: input.request.grouped }));
    }

    if (type === "line") {
      const tension = input.request.tension ?? (input.request.smooth ? 0.35 : 0);
      datasets = datasets.map((dataset) => ({
        ...dataset,
        tension,
        fill: input.request.fill ?? false,
        stepped: input.request.step ?? false,
        ...(typeof input.request.pointRadius === "number" ? { pointRadius: input.request.pointRadius } : {})
      }));
    }

    if ((type === "pie" || type === "doughnut") && input.request.showPercentLabels) {
      const values = (datasets[0].data as number[]) ?? [];
      const total = values.reduce((sum, value) => sum + value, 0);
      if (total > 0) {
        finalLabels = finalLabels.map((label, idx) => {
          const value = values[idx] ?? 0;
          const percentage = (value / total) * 100;
          return `${label} (${percentage.toFixed(1)}%)`;
        });
      }
    }

    const shouldUseStackedScales =
      type === "bar" && (input.request.stacked === true || input.request.percentStacked === true);

    const config: ChartConfiguration = {
      type,
      data: {
        labels: finalLabels,
        datasets
      },
      options: {
        responsive: false,
        ...(input.request.horizontal && type === "bar" ? { indexAxis: "y" as const } : {}),
        plugins: {
          title: input.request.title
            ? {
                display: true,
                text: input.request.title
              }
            : undefined
        },
        ...(shouldUseStackedScales
          ? {
              scales: {
                x: { stacked: true },
                y: {
                  stacked: true,
                  ...(input.request.percentStacked ? { min: 0, max: 100 } : {})
                }
              }
            }
          : {})
        ,
        ...((type === "doughnut" || type === "pie") && typeof input.request.donutCutout === "number"
          ? { cutout: `${input.request.donutCutout}%` }
          : {})
      }
    };

    return {
      config: config as unknown as Record<string, unknown>,
      summary: {
        type,
        xKey,
        yKey,
        seriesKey,
        labelsCount: finalLabels.length,
        datasetsCount: datasets.length,
        pointsCount: finalLabels.length * Math.max(1, datasets.length)
      }
    };
  }
}
