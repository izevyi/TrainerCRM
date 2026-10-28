import { describe, expect, it } from "vitest";

import {
  CHART_VIEWBOX,
  buildChartPoints,
  selectTickIndices,
  summarizeTrend,
  type ChartObservation,
} from "./chart-presentation";

const observations = (values: readonly number[]): ChartObservation[] =>
  values.map((value, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    value,
  }));

describe("buildChartPoints", () => {
  it.each([
    [[], 0],
    [[10], 1],
    [[10, 20], 2],
    [[10, 20, 15], 3],
    [Array.from({ length: 24 }, (_, index) => index), 24],
  ])("keeps every observation for %#", (values, expectedLength) => {
    expect(buildChartPoints(observations(values))).toHaveLength(expectedLength);
  });

  it("uses a stable centered baseline for equal values", () => {
    const points = buildChartPoints(observations([42, 42, 42]));
    expect(points.map(({ y }) => y)).toEqual([90, 90, 90]);
  });

  it("returns finite coordinates inside the padded plot area", () => {
    const points = buildChartPoints(observations([10, 30, 20, 50]));
    for (const point of points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(CHART_VIEWBOX.paddingX);
      expect(point.x).toBeLessThanOrEqual(
        CHART_VIEWBOX.width - CHART_VIEWBOX.paddingX,
      );
      expect(point.y).toBeGreaterThanOrEqual(CHART_VIEWBOX.paddingY);
      expect(point.y).toBeLessThanOrEqual(
        CHART_VIEWBOX.height - CHART_VIEWBOX.paddingY,
      );
    }
  });

  it("does not mutate input and safely centers non-finite values", () => {
    const input = Object.freeze([
      Object.freeze({ date: "2026-10-01", value: Number.NaN }),
      Object.freeze({ date: "2026-10-02", value: Number.POSITIVE_INFINITY }),
    ]);
    const before = input.map(({ date, value }) => ({ date, value }));

    const points = buildChartPoints(input);

    expect(points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(points.map(({ y }) => y)).toEqual([90, 90]);
    expect(input).toEqual(before);
  });
});

describe("selectTickIndices", () => {
  it("retains first and last without duplicates", () => {
    const ticks = selectTickIndices(23, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(22);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("limits mobile to three and desktop to five", () => {
    expect(selectTickIndices(25, 3)).toHaveLength(3);
    expect(selectTickIndices(25, 5)).toHaveLength(5);
  });

  it("keeps all labels when 0, 1, 2, or 3 fit", () => {
    expect(selectTickIndices(0, 3)).toEqual([]);
    expect(selectTickIndices(1, 3)).toEqual([0]);
    expect(selectTickIndices(2, 3)).toEqual([0, 1]);
    expect(selectTickIndices(3, 3)).toEqual([0, 1, 2]);
  });
});

describe("summarizeTrend", () => {
  it.each([
    [[], "insufficient", null],
    [[10], "insufficient", null],
    [[10, 12], "increase", 2],
    [[12, 10], "decrease", -2],
    [[10, 10], "unchanged", 0],
  ] as const)("summarizes %#", (values, direction, delta) => {
    expect(summarizeTrend(observations(values))).toMatchObject({
      direction,
      delta,
    });
  });
});
