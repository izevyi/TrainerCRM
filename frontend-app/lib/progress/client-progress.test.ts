import { describe, expect, it } from "vitest";

import type { Training, TrainingExercises } from "../domain/trainer-crm";
import {
  buildClientProgress,
  normalizeExerciseName,
} from "./client-progress";

const training = (
  overrides: Partial<Training> & Pick<Training, "id">,
): Training => ({
  clientId: 1,
  clientName: "Клиент",
  date: "2026-10-03",
  time: "10:00",
  type: "Персональная",
  completed: true,
  ...overrides,
  id: overrides.id,
});

describe("buildClientProgress", () => {
  it("filters by client and completion, counts the local month, and finds the deterministic latest training", () => {
    const trainings = [
      training({ id: 1, date: "2026-09-30" }),
      training({ id: 2, time: "11:00", type: "Силовая" }),
      training({ id: 4, time: "11:00", type: "Функциональная" }),
      training({ id: 5, completed: false }),
      training({ id: 6, clientId: 2 }),
    ];

    const result = buildClientProgress(1, trainings, {}, new Date(2026, 9, 20));

    expect(result.completedThisMonth).toBe(2);
    expect(result.completedTotal).toBe(3);
    expect(result.latestCompleted).toEqual({
      id: 4,
      date: "2026-10-03",
      time: "11:00",
      type: "Функциональная",
    });
  });

  it("joins exercise ownership only through eligible training IDs and ignores orphan data", () => {
    const trainings = [
      training({ id: 10 }),
      training({ id: 11, clientId: 2 }),
      training({ id: 12, completed: false }),
    ];
    const exercises: TrainingExercises = {
      10: [{ id: 1, name: "Жим", sets: [{ id: 1, weight: 40, reps: 8 }] }],
      11: [{ id: 1, name: "Чужая тяга", sets: [{ id: 1, weight: 50, reps: 8 }] }],
      12: [{ id: 1, name: "Незавершённое", sets: [{ id: 1, weight: 60, reps: 8 }] }],
      99: [{ id: 1, name: "Сирота", sets: [{ id: 1, weight: 70, reps: 8 }] }],
    };

    expect(buildClientProgress(1, trainings, exercises, new Date()).exercises.map(({ name }) => name)).toEqual(["Жим"]);
  });

  it("groups normalized names, orders history chronologically, and prefers the most recent spelling", () => {
    const trainings = [
      training({ id: 2, date: "2026-10-02" }),
      training({ id: 1, date: "2026-10-01" }),
    ];
    const exercises: TrainingExercises = {
      1: [{ id: 1, name: "  ЖИМ   лёжа ", sets: [{ id: 1, weight: 40, reps: 10 }] }],
      2: [{ id: 9, name: "Жим лёжа", sets: [{ id: 1, weight: 45, reps: 8 }] }],
    };

    const result = buildClientProgress(1, trainings, exercises, new Date());

    expect(normalizeExerciseName("  ЖИМ   лёжа ")).toBe("жим лёжа");
    expect(result.exercises).toHaveLength(1);
    expect(result.exercises[0].name).toBe("Жим лёжа");
    expect(result.exercises[0].occurrences.map(({ trainingId }) => trainingId)).toEqual([1, 2]);
  });

  it("preserves performed sets and uses only their maximum positive weight", () => {
    const exercises: TrainingExercises = {
      1: [{
        id: 1,
        name: "Присед",
        sets: [
          { id: 1, weight: 100, reps: 0 },
          { id: 2, weight: 0, reps: 12 },
          { id: 3, weight: 55, reps: 8 },
          { id: 4, weight: 50, reps: 10 },
        ],
      }],
    };

    const occurrence = buildClientProgress(1, [training({ id: 1 })], exercises, new Date()).exercises[0].occurrences[0];

    expect(occurrence.sets.map(({ id }) => id)).toEqual([2, 3, 4]);
    expect(occurrence.workingWeight).toBe(55);
  });

  it("retains bodyweight history without kilogram points and excludes zero-repetition exercises", () => {
    const exercises: TrainingExercises = {
      1: [
        { id: 1, name: "Подтягивания", sets: [{ id: 1, weight: 0, reps: 8 }] },
        { id: 2, name: "Планка", sets: [{ id: 1, weight: 0, reps: 0 }] },
      ],
    };

    const result = buildClientProgress(1, [training({ id: 1 })], exercises, new Date());

    expect(result.exercises).toHaveLength(1);
    expect(result.exercises[0].occurrences[0].workingWeight).toBeNull();
    expect(result.exercises[0].weightedOccurrences).toEqual([]);
  });

  it("handles empty, one-point, and repeated histories without mutating inputs", () => {
    const trainings = [training({ id: 2 }), training({ id: 1, date: "2026-10-01" })];
    const exercises: TrainingExercises = {
      1: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 0, reps: 10 }] }],
      2: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 60, reps: 8 }] }],
    };
    const before = JSON.stringify({ trainings, exercises });

    expect(buildClientProgress(9, trainings, exercises, new Date()).exercises).toEqual([]);
    const result = buildClientProgress(1, trainings, exercises, new Date());
    expect(result.exercises[0].occurrences).toHaveLength(2);
    expect(result.exercises[0].weightedOccurrences).toHaveLength(1);
    expect(JSON.stringify({ trainings, exercises })).toBe(before);
  });
});
