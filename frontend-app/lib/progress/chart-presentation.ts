export type ChartObservation = {
  date: string;
  value: number;
};

export type ChartPoint = {
  index: number;
  x: number;
  y: number;
};

export type TrendDirection =
  | "insufficient"
  | "increase"
  | "decrease"
  | "unchanged";

export type TrendSummary = {
  count: number;
  first: ChartObservation | null;
  latest: ChartObservation | null;
  delta: number | null;
  direction: TrendDirection;
};

export const CHART_VIEWBOX = {
  width: 640,
  height: 180,
  paddingX: 24,
  paddingY: 30,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function buildChartPoints(
  observations: readonly ChartObservation[],
): ChartPoint[] {
  if (observations.length === 0) return [];

  const finiteValues = observations
    .map(({ value }) => value)
    .filter(Number.isFinite);
  const min = finiteValues.length > 0 ? Math.min(...finiteValues) : 0;
  const max = finiteValues.length > 0 ? Math.max(...finiteValues) : 0;
  const hasRange = max > min;
  const plotWidth = CHART_VIEWBOX.width - CHART_VIEWBOX.paddingX * 2;
  const plotHeight = CHART_VIEWBOX.height - CHART_VIEWBOX.paddingY * 2;
  const centerY = CHART_VIEWBOX.height / 2;

  return observations.map(({ value }, index) => {
    const x =
      observations.length === 1
        ? CHART_VIEWBOX.width / 2
        : CHART_VIEWBOX.paddingX +
          (index / (observations.length - 1)) * plotWidth;
    const normalized = hasRange && Number.isFinite(value)
      ? (value - min) / (max - min)
      : 0.5;
    const y = hasRange
      ? CHART_VIEWBOX.height -
        CHART_VIEWBOX.paddingY -
        clamp(normalized, 0, 1) * plotHeight
      : centerY;

    return {
      index,
      x: clamp(x, CHART_VIEWBOX.paddingX, CHART_VIEWBOX.width - CHART_VIEWBOX.paddingX),
      y: clamp(y, CHART_VIEWBOX.paddingY, CHART_VIEWBOX.height - CHART_VIEWBOX.paddingY),
    };
  });
}

export function selectTickIndices(length: number, maximum: number): number[] {
  const count = Math.max(0, Math.floor(length));
  const limit = Math.max(0, Math.floor(maximum));
  if (count === 0 || limit === 0) return [];
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);
  if (limit === 1) return [0];

  return Array.from(
    new Set(
      Array.from({ length: limit }, (_, index) =>
        Math.round((index * (count - 1)) / (limit - 1)),
      ),
    ),
  );
}

export function summarizeTrend(
  observations: readonly ChartObservation[],
): TrendSummary {
  const first = observations[0] ?? null;
  const latest = observations.at(-1) ?? null;
  if (!first || !latest || observations.length < 2) {
    return {
      count: observations.length,
      first,
      latest,
      delta: null,
      direction: "insufficient",
    };
  }

  const delta = latest.value - first.value;
  return {
    count: observations.length,
    first,
    latest,
    delta,
    direction:
      delta > 0 ? "increase" : delta < 0 ? "decrease" : "unchanged",
  };
}
