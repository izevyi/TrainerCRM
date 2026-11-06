import { describe, expect, it } from "vitest";

import type { Client } from "../domain/trainer-crm";
import {
  addWeightMeasurement,
  deleteWeightMeasurement,
  deriveCurrentWeight,
  deriveWeightGraphData,
  editWeightMeasurement,
  isValidMeasurementDate,
  isValidMeasurementWeight,
  sortWeightMeasurements,
} from "./weight-history";

const legacyClient: Client = { id: 7, name: "Анна", weight: 72, startWeight: 76 };

describe("weight history", () => {
  it.each(["2024-02-29", "2000-02-29", "2026-12-31"])("accepts valid date %s", (date) => {
    expect(isValidMeasurementDate(date)).toBe(true);
  });

  it.each(["2023-02-29", "1900-02-29", "2026-02-30", "2026-13-01", "01.01.2026", "2026-1-01"])("rejects invalid date %s", (date) => {
    expect(isValidMeasurementDate(date)).toBe(false);
  });

  it.each([0, -1, Number.NaN, Infinity, -Infinity])("rejects invalid weight %s", (weight) => {
    expect(isValidMeasurementWeight(weight)).toBe(false);
  });

  it("adds chronologically, updates current weight, and keeps stable identifiers", () => {
    const later = addWeightMeasurement(legacyClient, { date: "2026-06-10", weight: 71 });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    const earlier = addWeightMeasurement(later.client, { date: "2026-06-01", weight: 73 });
    expect(earlier.ok).toBe(true);
    if (!earlier.ok) return;

    expect(earlier.client.weightMeasurements?.map(({ date }) => date)).toEqual(["2026-06-01", "2026-06-10"]);
    expect(earlier.client.weight).toBe(71);
    expect(earlier.client.weightMeasurements?.[1].id).toBe(later.measurement.id);
    expect(new Set(earlier.client.weightMeasurements?.map(({ id }) => id)).size).toBe(2);
  });

  it("rejects duplicate dates", () => {
    const first = addWeightMeasurement(legacyClient, { date: "2026-06-10", weight: 71 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(addWeightMeasurement(first.client, { date: "2026-06-10", weight: 70 })).toMatchObject({ ok: false, field: "date" });
  });

  it("edits without changing identity and rejects an edit to a duplicate date", () => {
    const first = addWeightMeasurement(legacyClient, { date: "2026-06-01", weight: 73 });
    if (!first.ok) throw new Error("fixture failed");
    const second = addWeightMeasurement(first.client, { date: "2026-06-10", weight: 71 });
    if (!second.ok) throw new Error("fixture failed");
    const edited = editWeightMeasurement(second.client, first.measurement.id, { date: "2026-06-02", weight: 72.5 });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.measurement.id).toBe(first.measurement.id);
    expect(editWeightMeasurement(edited.client, first.measurement.id, { date: "2026-06-10", weight: 70 })).toMatchObject({ ok: false, field: "date" });
  });

  it("deletes immutably and derives latest weight and graph data", () => {
    const source: Client = {
      ...legacyClient,
      weight: 70,
      weightMeasurements: [
        { id: "later", date: "2026-02-02", weight: 70 },
        { id: "earlier", date: "2026-01-01", weight: 74 },
      ],
    };
    const result = deleteWeightMeasurement(source, "later");
    expect(result).not.toBe(source);
    expect(result.weightMeasurements).not.toBe(source.weightMeasurements);
    expect(result.weight).toBe(74);
    expect(source.weightMeasurements).toHaveLength(2);
    expect(deriveCurrentWeight(source)).toBe(70);
    expect(deriveWeightGraphData(source)).toEqual([
      { date: "2026-01-01", value: 74 },
      { date: "2026-02-02", value: 70 },
    ]);
  });

  it("preserves the baseline and legacy current weight without history", () => {
    const added = addWeightMeasurement(legacyClient, { date: "2026-01-01", weight: 75 });
    expect(legacyClient.startWeight).toBe(76);
    expect(deriveCurrentWeight(legacyClient)).toBe(72);
    expect(sortWeightMeasurements(legacyClient.weightMeasurements)).toEqual([]);
    expect(added.ok && added.client.startWeight).toBe(76);
  });
});


describe("weight history regression fixes", () => {
  it("restores the previous current weight after the last measurement is removed", () => {
    const original: Client = {
      id: 99, name: "Тест", weight: 105, startWeight: 109,
    };
    const added = addWeightMeasurement(original, {
      date: "2026-11-06", weight: 104,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const restored = deleteWeightMeasurement(
      added.client, added.measurement.id,
    );

    expect(restored.weight).toBe(105);
    expect(restored.startWeight).toBe(109);
    expect(restored.weightMeasurements).toEqual([]);
    expect(original.weight).toBe(105);
  });

  it("does not reuse deleted measurement IDs", () => {
    const first = addWeightMeasurement(legacyClient, {
      date: "2026-11-01", weight: 71,
    });
    if (!first.ok) throw new Error("fixture");

    const afterDelete = deleteWeightMeasurement(
      first.client, first.measurement.id,
    );
    const second = addWeightMeasurement(afterDelete, {
      date: "2026-11-02", weight: 70,
    });
    if (!second.ok) throw new Error("fixture");

    expect(second.measurement.id).not.toBe(first.measurement.id);
    expect(second.client.nextWeightMeasurementSequence).toBe(3);
  });
});
