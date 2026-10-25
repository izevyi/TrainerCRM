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

  it("totals recorded calories only for completed client trainings in the local month", () => {
    const trainings = [
      training({ id: 1, date: "2026-09-30", caloriesBurned: 200 }),
      training({ id: 2, caloriesBurned: 0 }),
      training({ id: 3 }),
      training({ id: 4, completed: false, caloriesBurned: 500 }),
      training({ id: 5, clientId: 2, caloriesBurned: 600 }),
    ];

    const result = buildClientProgress(
      1,
      trainings,
      {},
      new Date(2026, 9, 20),
    );

    expect(result.caloriesThisMonth).toBe(0);
    expect(result.caloriesTotal).toBe(200);
  });

  it("reports missing calorie data independently for month and all time", () => {
    const noData = buildClientProgress(
      1,
      [training({ id: 1 })],
      {},
      new Date(2026, 9, 20),
    );
    const priorOnly = buildClientProgress(
      1,
      [training({ id: 2, date: "2026-09-30", caloriesBurned: 250 })],
      {},
      new Date(2026, 9, 20),
    );

    expect(noData.caloriesThisMonth).toBeNull();
    expect(noData.caloriesTotal).toBeNull();
    expect(priorOnly.caloriesThisMonth).toBeNull();
    expect(priorOnly.caloriesTotal).toBe(250);
  });

  it("counts calories for a duplicated training ID only once", () => {
    const trainings = [
      training({ id: 7, caloriesBurned: 125 }),
      training({ id: 7, caloriesBurned: 125 }),
    ];

    const result = buildClientProgress(
      1,
      trainings,
      {},
      new Date(2026, 9, 20),
    );

    expect(result.caloriesThisMonth).toBe(125);
    expect(result.caloriesTotal).toBe(125);
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
    expect(occurrence.setCount).toBe(3);
    expect(occurrence.repCount).toBe(30);
    expect(occurrence.volumeKg).toBe(940);
    expect(occurrence.hasUnrecordedLoad).toBe(true);
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
    expect(result.exercises[0].strengthChange).toBeNull();
    expect(JSON.stringify({ trainings, exercises })).toBe(before);
  });

  it("merges duplicate normalized exercise names within a training", () => {
    const exercises: TrainingExercises = {
      1: [
        {
          id: 1,
          name: " Жим лёжа ",
          sets: [{ id: 1, weight: 40, reps: 10 }],
        },
        {
          id: 2,
          name: "ЖИМ   ЛЁЖА",
          sets: [
            { id: 1, weight: 45, reps: 8 },
            { id: 2, weight: 0, reps: 6 },
          ],
        },
      ],
    };

    const result = buildClientProgress(
      1,
      [training({ id: 1 })],
      exercises,
      new Date(2026, 9, 20),
    );
    const exercise = result.exercises[0];

    expect(exercise.occurrences).toHaveLength(1);
    expect(exercise.occurrences[0]).toMatchObject({
      workingWeight: 45,
      setCount: 3,
      repCount: 24,
      volumeKg: 760,
      hasUnrecordedLoad: true,
    });
    expect(result.volumeThisMonthKg).toBe(760);
    expect(result.volumeTotalKg).toBe(760);
  });

  it("splits analytics history when one completed occurrence is renamed", () => {
    const trainings = [
      training({ id: 1, date: "2026-10-01" }),
      training({ id: 2, date: "2026-10-02" }),
    ];
    const exercises: TrainingExercises = {
      1: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 40, reps: 10 }] }],
      2: [{ id: 1, name: "Тяга сумо", sets: [{ id: 1, weight: 50, reps: 8 }] }],
    };
    const before = JSON.stringify({ trainings, exercises });

    const result = buildClientProgress(
      1,
      trainings,
      exercises,
      new Date(2026, 9, 20),
    );

    expect(result.exercises.map(({ key }) => key).sort()).toEqual([
      "тяга",
      "тяга сумо",
    ]);
    expect(result.exercises.flatMap(({ occurrences }) =>
      occurrences.map(({ trainingId }) => trainingId)).sort(),
    ).toEqual([1, 2]);
    expect(result.volumeTotalKg).toBe(800);
    expect(JSON.stringify({ trainings, exercises })).toBe(before);
  });

  it("merges analytics history when a completed occurrence is renamed to an existing normalized name", () => {
    const trainings = [
      training({ id: 1, date: "2026-10-01" }),
      training({ id: 2, date: "2026-10-02" }),
      training({ id: 3, date: "2026-10-03", completed: false }),
    ];
    const exercises: TrainingExercises = {
      1: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 40, reps: 10 }] }],
      2: [{ id: 1, name: " ТЯГА ", sets: [{ id: 1, weight: 50, reps: 8 }] }],
      3: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 60, reps: 6 }] }],
    };

    const result = buildClientProgress(
      1,
      trainings,
      exercises,
      new Date(2026, 9, 20),
    );

    expect(result.exercises).toHaveLength(1);
    expect(result.exercises[0].name).toBe("ТЯГА");
    expect(result.exercises[0].occurrences.map(({ trainingId }) => trainingId))
      .toEqual([1, 2]);
    expect(result.volumeTotalKg).toBe(800);
  });

  it("calculates first-to-latest strength change at full precision", () => {
    const trainings = [
      training({ id: 3, date: "2026-10-02", time: "09:00" }),
      training({ id: 2, date: "2026-10-01", time: "09:00" }),
      training({ id: 1, date: "2026-10-01", time: "09:00" }),
    ];
    const exercises: TrainingExercises = {
      1: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 37.5, reps: 8 }] }],
      2: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 40, reps: 8 }] }],
      3: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 42.5, reps: 6 }] }],
    };

    const exercise = buildClientProgress(
      1,
      trainings,
      exercises,
      new Date(2026, 9, 20),
    ).exercises[0];

    expect(exercise.occurrences.map(({ trainingId }) => trainingId)).toEqual([
      1, 2, 3,
    ]);
    expect(exercise.strengthChange).toEqual({
      firstWeight: 37.5,
      latestWeight: 42.5,
      deltaKg: 5,
      deltaPct: (5 / 37.5) * 100,
    });
  });

  it("excludes invalid numeric contributions and aggregates recorded load by month and all time", () => {
    const trainings = [
      training({ id: 1, date: "2026-09-30" }),
      training({ id: 2, date: "2026-10-01" }),
    ];
    const exercises: TrainingExercises = {
      1: [{ id: 1, name: "Присед", sets: [{ id: 1, weight: 50, reps: 2 }] }],
      2: [{
        id: 1,
        name: "Присед",
        sets: [
          { id: 1, weight: 20, reps: 5 },
          { id: 2, weight: -10, reps: 4 },
          { id: 3, weight: Number.POSITIVE_INFINITY, reps: 3 },
          { id: 4, weight: 10, reps: Number.NaN },
          { id: 5, weight: 10, reps: -2 },
          { id: 6, weight: Number.MAX_VALUE, reps: 2 },
        ],
      }],
    };

    const result = buildClientProgress(
      1,
      trainings,
      exercises,
      new Date(2026, 9, 20),
    );
    const latest = result.exercises[0].occurrences.at(-1)!;

    expect(latest).toMatchObject({
      workingWeight: Number.MAX_VALUE,
      setCount: 4,
      repCount: 14,
      volumeKg: 100,
      hasUnrecordedLoad: true,
    });
    expect(result.volumeThisMonthKg).toBe(100);
    expect(result.volumeTotalKg).toBe(200);
    expect(result.hasUnrecordedLoadThisMonth).toBe(true);
    expect(result.hasUnrecordedLoadTotal).toBe(true);
  });
});
