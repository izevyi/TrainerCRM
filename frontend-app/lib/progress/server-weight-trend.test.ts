import { describe, expect, it } from "vitest";
import { buildChartPoints } from "./chart-presentation";
import { buildServerWeightTrend } from "./server-weight-trend";

describe("server weight trend with starting baseline", () => {
  it("keeps baseline without a date when no measurements exist", () => {
    const result = buildServerWeightTrend(140, []);
    expect(result).toMatchObject({
      observations: [{ date: "Старт", value: 140 }],
      measurementCount: 0,
      latestWeight: 140,
      latestDate: null,
      delta: 0,
    });
  });

  it("counts one subsequent weighing as enough to show change from the starting weight", () => {
    const result = buildServerWeightTrend(140, [{ date: "2026-11-22", weight: 139.5 }]);
    expect(result).toMatchObject({
      observations: [{ date: "Старт", value: 140 }, { date: "2026-11-22", value: 139.5 }],
      measurementCount: 1,
      latestWeight: 139.5,
      latestDate: "2026-11-22",
      delta: -0.5,
    });
    const chart = buildChartPoints(result.observations);
    expect(chart).toHaveLength(2);
    expect(chart[0].x).toBeLessThan(chart[1].x);
    expect(chart[0].y).toBeLessThan(chart[1].y);
  });

  it("sorts weighings chronologically, without modifying input or fabricating a baseline date", () => {
    const input = Object.freeze([
      Object.freeze({ date: "2026-11-29", weight: 138 }),
      Object.freeze({ date: "2026-11-22", weight: 139.5 }),
    ]);
    const result = buildServerWeightTrend(140, input);
    expect(result.observations).toEqual([
      { date: "Старт", value: 140 },
      { date: "2026-11-22", value: 139.5 },
      { date: "2026-11-29", value: 138 },
    ]);
    expect(result.delta).toBe(-2);
    expect(result.latestWeight).toBe(138);
    expect(input[0].date).toBe("2026-11-29");
  });

  it("shows positive change, unchanged weight and decimal precision", () => {
    expect(buildServerWeightTrend(72.4, [{ date: "2026-11-22", weight: 72.7 }]).delta).toBe(0.3);
    expect(buildServerWeightTrend(72.4, [{ date: "2026-11-22", weight: 72.4 }]).delta).toBe(0);
  });
});
