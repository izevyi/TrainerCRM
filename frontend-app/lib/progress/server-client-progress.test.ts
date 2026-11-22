import { describe, expect, it } from "vitest";
import type { Workout } from "../workouts/workout-api";
import { buildServerClientProgress } from "./server-client-progress";

const sample: Workout = {
  id: "10000000-0000-4000-8000-000000000001",
  clientId: "20000000-0000-4000-8000-000000000001",
  clientName: "Test",
  appointmentId: null,
  date: "2026-11-22", time: "09:00", type: "Personal", completed: true,
  caloriesBurned: 220, createdAt: "2026-11-22T01:00:00Z", updatedAt: "2026-11-22T01:00:00Z",
  exercises: [{ id: "30000000-0000-4000-8000-000000000001", name: "Жим лёжа", sets: [
    { id: "40000000-0000-4000-8000-000000000001", weight: 40, reps: 10 },
  ] }],
};

describe("UUID server workout progress adapter", () => {
  it("reuses existing chart math without persisting synthetic numeric ids", () => {
    const result = buildServerClientProgress([sample], new Date(2026, 10, 22));
    expect(result.completedTotal).toBe(1);
    expect(result.completedThisMonth).toBe(1);
    expect(result.caloriesTotal).toBe(220);
    expect(result.exercises[0].occurrences[0].volumeKg).toBe(400);
  });
  it("ignores unfinished workouts in completed statistics", () => {
    expect(buildServerClientProgress([{ ...sample, completed: false }]).completedTotal).toBe(0);
  });
});
