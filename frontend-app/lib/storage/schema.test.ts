import { describe, expect, it } from "vitest";

import type { TrainerCrmData } from "../domain/trainer-crm";
import {
  decodeSlice,
  isClients,
  isTrainingExercises,
  isTrainings,
  normalizeOwnedReferences,
  serializeSlice,
} from "./schema";

const client = { id: 1, name: "Анна 🏋️", weight: 72.4, startWeight: 76 };
const training = {
  id: 10,
  clientId: 1,
  clientName: "Анна 🏋️",
  date: "2026-08-11",
  time: "09:00",
  type: "Персональная",
  completed: false,
};
const exercise = {
  id: 4,
  name: "Жим",
  sets: [{ id: 5, weight: 47.5, reps: 0 }],
};

describe("TrainerCRM schema", () => {
  it("accepts valid legacy values, empty collections, and extra fields", () => {
    expect(decodeSlice([{ ...client, extra: true }], isClients)).toEqual({
      status: "legacy",
      data: [{ ...client, extra: true }],
      needsMigration: true,
    });
    expect(isClients([])).toBe(true);
    expect(isTrainings([])).toBe(true);
    expect(isTrainingExercises({})).toBe(true);
  });

  it.each([
    [{ ...client, weight: Number.NaN }],
    [{ ...client, startWeight: Number.POSITIVE_INFINITY }],
    [{ ...client, id: 1.5 }],
    [{ ...client, name: 4 }],
  ])("rejects invalid client data", (value: unknown) => {
    expect(isClients(value)).toBe(false);
  });

  it("validates nested exercises and canonical numeric map keys", () => {
    expect(isTrainingExercises({ 10: [exercise] })).toBe(true);
    expect(isTrainingExercises({ nope: [exercise] })).toBe(false);
    expect(isTrainingExercises({ "01": [exercise] })).toBe(false);
    expect(isTrainingExercises({ 10: [{ ...exercise, sets: [{ ...exercise.sets[0], reps: Infinity }] }] })).toBe(false);
  });

  it("round-trips a canonical v1 slice and rejects future versions", () => {
    const serialized = serializeSlice([training], isTrainings);
    expect(decodeSlice(JSON.parse(serialized), isTrainings)).toEqual({
      status: "v1",
      data: [training],
      needsMigration: false,
    });
    expect(decodeSlice({ schemaVersion: 2, data: [training] }, isTrainings)).toEqual({
      status: "unsupported-version",
      version: 2,
    });
  });

  it("removes only orphan-owned exercises and is idempotent", () => {
    const source: TrainerCrmData = {
      clients: [],
      trainings: [training],
      exercises: { 10: [exercise], 99: [exercise] },
    };
    const once = normalizeOwnedReferences(source);
    const twice = normalizeOwnedReferences(once.data);

    expect(once.data.trainings).toEqual([training]);
    expect(once.data.exercises).toEqual({ 10: [exercise] });
    expect(once.removedExerciseTrainingIds).toEqual([99]);
    expect(once.danglingClientTrainingIds).toEqual([10]);
    expect(twice.data).toEqual(once.data);
    expect(twice.removedExerciseTrainingIds).toEqual([]);
  });
});
