import { describe, expect, it } from "vitest";
import { appointmentRanges, localDateKey, localDateTime, localDateTimeFields, monthGrid, resolveLocalDateTime } from "./calendar-date";

describe("server calendar date calculations", () => {
  it("builds complete Monday-to-Sunday month grids", () => {
    const august = monthGrid(new Date(2026, 7, 1));
    expect(august).toHaveLength(42);
    expect(localDateKey(august[0])).toBe("2026-07-27");
    expect(localDateKey(august.at(-1)!)).toBe("2026-09-06");
  });

  it("splits long grids into contiguous API ranges no longer than 31 days", () => {
    const ranges = appointmentRanges(monthGrid(new Date(2026, 7, 1)));
    expect(ranges.length).toBe(2);
    expect(ranges[0].to).toBe(ranges[1].from);
    for (const range of ranges) expect(Date.parse(range.to) - Date.parse(range.from)).toBeLessThanOrEqual(31 * 86_400_000);
  });

  it("creates browser-local times that serialize with an explicit UTC designator", () => {
    const value = localDateTime(new Date(2026, 10, 13), "09:30");
    expect(value?.getHours()).toBe(9);
    expect(value?.getMinutes()).toBe(30);
    expect(value?.toISOString()).toMatch(/Z$/);
    expect(localDateTime(new Date(2026, 10, 13), "25:00")).toBeNull();
  });

  it("supports overnight sessions and month/year boundaries", () => {
    const start = resolveLocalDateTime("2026-12-31", "23:30");
    const end = resolveLocalDateTime("2027-01-01", "00:30");
    expect(start.ok && end.ok && end.value.getTime() - start.value.getTime()).toBe(60 * 60_000);
  });

  it("rejects invalid calendar values and end instants that are not later", () => {
    expect(resolveLocalDateTime("2026-02-30", "10:00")).toEqual({ ok: false, reason: "invalid" });
    const start = resolveLocalDateTime("2026-11-13", "10:00");
    const end = resolveLocalDateTime("2026-11-13", "10:00");
    expect(start.ok && end.ok && end.value.getTime() <= start.value.getTime()).toBe(true);
  });

  it("refuses nonexistent and ambiguous local times without silently normalizing", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(resolveLocalDateTime("2026-03-08", "02:30")).toEqual({ ok: false, reason: "nonexistent" });
      expect(resolveLocalDateTime("2026-11-01", "01:30")).toEqual({ ok: false, reason: "ambiguous" });
    } finally {
      process.env.TZ = previous;
    }
  });

  it("retains the fields of either repeated-hour occurrence for unchanged-save preservation", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(localDateTimeFields("2026-11-01T05:30:00.000Z")).toEqual({ date: "2026-11-01", time: "01:30" });
      expect(localDateTimeFields("2026-11-01T06:30:00.000Z")).toEqual({ date: "2026-11-01", time: "01:30" });
    } finally {
      process.env.TZ = previous;
    }
  });
});
