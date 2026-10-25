import { describe, expect, it } from "vitest";

import type {
  TrainerCrmData,
  Training,
  TrainingExercises,
} from "./domain/trainer-crm";
import {
  TRAINER_CRM_STORAGE_KEYS,
  TrainerCrmRepository,
  type StoragePort,
} from "./storage/trainer-crm-repository";
import {
  deleteOwnedTraining,
  parseExerciseNumber,
  renameExercise,
  updateExerciseSetValue,
} from "./training-editor";

const trainings: Training[] = [
  {
    id: 10,
    clientId: 1,
    clientName: "Анна",
    date: "2026-10-25",
    time: "09:00",
    type: "Персональная",
    completed: true,
  },
  {
    id: 20,
    clientId: 2,
    clientName: "Борис",
    date: "2026-10-25",
    time: "10:00",
    type: "Персональная",
    completed: false,
    caloriesBurned: 0,
  },
];

const exercises: TrainingExercises = {
  10: [
    {
      id: 1,
      name: "Жим лёжа",
      sets: [{ id: 101, weight: 40.3, reps: 8 }],
    },
    {
      id: 2,
      name: "Тяга",
      sets: [{ id: 201, weight: 50, reps: 10 }],
    },
  ],
  20: [
    {
      id: 1,
      name: "Жим лёжа",
      sets: [{ id: 301, weight: 60, reps: 6 }],
    },
  ],
};

class MemoryStorage implements StoragePort {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("training editor", () => {
  it("renames only the owned exercise while preserving IDs and sets", () => {
    const result = renameExercise(exercises, 10, 1, "  Жим   гантелей  ");

    expect(result.status).toBe("updated");
    expect(result.duplicateName).toBe(false);
    expect(result.exercises[10][0]).toEqual({
      ...exercises[10][0],
      name: "Жим гантелей",
    });
    expect(result.exercises[10][0].sets).toBe(exercises[10][0].sets);
    expect(result.exercises[10][1]).toBe(exercises[10][1]);
    expect(result.exercises[20]).toBe(exercises[20]);
  });

  it("rejects empty names and allows normalized duplicates with a warning", () => {
    const empty = renameExercise(exercises, 10, 1, " \n ");
    const duplicate = renameExercise(exercises, 10, 1, " ТЯГА ");

    expect(empty).toEqual({
      exercises,
      status: "empty",
      duplicateName: false,
    });
    expect(duplicate.status).toBe("updated");
    expect(duplicate.duplicateName).toBe(true);
    expect(duplicate.exercises[10].map(({ id }) => id)).toEqual([1, 2]);
    expect(duplicate.exercises[10][0].sets[0].id).toBe(101);
  });

  it("accepts exact half-kilogram weights and non-negative integer repetitions", () => {
    for (const value of ["0", "0.5", "40", "40.5", "41"]) {
      expect(parseExerciseNumber("weight", value)).toBe(Number(value));
    }
    for (const value of ["-1", "0.25", "40.3", "", "Infinity"]) {
      expect(parseExerciseNumber("weight", value)).toBeNull();
    }
    for (const value of ["0", "8", "12"]) {
      expect(parseExerciseNumber("reps", value)).toBe(Number(value));
    }
    for (const value of ["-1", "0.5", "", "NaN"]) {
      expect(parseExerciseNumber("reps", value)).toBeNull();
    }
  });

  it("does not mutate state for invalid or empty numeric commits", () => {
    const invalid = updateExerciseSetValue(
      exercises,
      10,
      1,
      101,
      "weight",
      "40.3",
    );
    const empty = updateExerciseSetValue(
      exercises,
      10,
      1,
      101,
      "reps",
      "",
    );

    expect(invalid).toEqual({ exercises, status: "invalid" });
    expect(empty).toEqual({ exercises, status: "invalid" });
    expect(exercises[10][0].sets[0]).toEqual({
      id: 101,
      weight: 40.3,
      reps: 8,
    });
  });

  it("updates explicit zero from latest state without normalizing legacy values", () => {
    const repsResult = updateExerciseSetValue(
      exercises,
      10,
      1,
      101,
      "reps",
      "0",
    );

    expect(repsResult.status).toBe("updated");
    expect(repsResult.exercises[10][0].sets[0]).toEqual({
      id: 101,
      weight: 40.3,
      reps: 0,
    });
    expect(exercises[10][0].sets[0].weight).toBe(40.3);
  });

  it("deletes only the selected training and its ownership entry immutably", () => {
    const result = deleteOwnedTraining(trainings, exercises, 10);

    expect(result.trainings).toEqual([trainings[1]]);
    expect(result.exercises).toEqual({ 20: exercises[20] });
    expect(result.exercises[20]).toBe(exercises[20]);
    expect(trainings).toHaveLength(2);
    expect(exercises[10]).toHaveLength(2);
  });

  it("remains compatible with schema v1 and preserves missing versus zero calories", () => {
    const renamed = renameExercise(exercises, 10, 1, "Жим гантелей");
    const updated = updateExerciseSetValue(
      renamed.exercises,
      10,
      1,
      101,
      "reps",
      "0",
    );
    const edited: TrainerCrmData = {
      clients: [],
      trainings,
      exercises: updated.exercises,
    };
    const deleted = deleteOwnedTraining(
      edited.trainings,
      edited.exercises,
      20,
    );
    const data: TrainerCrmData = {
      ...edited,
      trainings: deleted.trainings,
      exercises: deleted.exercises,
    };
    const storage = new MemoryStorage();
    const repository = new TrainerCrmRepository(storage);

    expect(repository.save(edited).ok).toBe(true);
    expect(Array.from(storage.values.keys())).toEqual(
      Object.values(TRAINER_CRM_STORAGE_KEYS),
    );
    for (const value of storage.values.values()) {
      expect(JSON.parse(value)).toMatchObject({ schemaVersion: 1 });
    }
    const reloadedEdited = repository.load({ clients: [], trainings: [], exercises: {} }).data;
    expect(reloadedEdited).toEqual(edited);
    expect(reloadedEdited.trainings[0]).not.toHaveProperty("caloriesBurned");
    expect(reloadedEdited.trainings[1].caloriesBurned).toBe(0);
    expect(reloadedEdited.exercises[10][0].sets[0].weight).toBe(40.3);

    expect(repository.save(data).ok).toBe(true);
    expect(repository.load({ clients: [], trainings: [], exercises: {} }).data)
      .toEqual(data);
    expect(data.trainings.some(({ id }) => id === 20)).toBe(false);
    expect(data.exercises).not.toHaveProperty("20");
  });
});
