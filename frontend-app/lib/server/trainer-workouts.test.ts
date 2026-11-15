import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createTrainerWorkout, getTrainerWorkout, listTrainerWorkouts,
  TrainerWorkoutError, updateTrainerWorkout, type WorkoutInput,
} from "./trainer-workouts";

const token = Buffer.alloc(32, 9).toString("base64url");
const digest = createHash("sha256").update(Buffer.alloc(32, 9)).digest();
const input: WorkoutInput = {
  clientId: "20000000-0000-4000-8000-000000000001", appointmentId: null,
  date: "2026-11-15", time: "10:30", type: "Personal training", completed: false,
  caloriesBurned: null, exercises: [{ name: "Squat", sets: [{ weight: 40, reps: 12 }] }],
};
const workout = { ...input, id: "30000000-0000-4000-8000-000000000001", clientName: "Alice",
  createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", exercises: [] };

describe("trainer workout database adapter", () => {
  it("lists and gets only through session-bound parameterized functions", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ workout }] });
    await listTrainerWorkouts(token, input.clientId, query);
    await getTrainerWorkout(token, workout.id, query);
    expect(query.mock.calls[0][1]).toEqual([digest, input.clientId]);
    expect(query.mock.calls[1][1]).toEqual([digest, workout.id]);
  });

  it("writes without accepting trainer or tenant selectors", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ workout }] });
    await createTrainerWorkout(token, input, query);
    await updateTrainerWorkout(token, workout.id, input, query);
    expect(query.mock.calls[0][1]).toHaveLength(9);
    expect(query.mock.calls[1][1]).toHaveLength(10);
    expect(query.mock.calls.every((call) => call[1][0].equals(digest))).toBe(true);
  });

  it.each([
    ["UNAUTHORIZED", "UNAUTHORIZED"], ["WORKOUT_NOT_FOUND", "NOT_FOUND"],
    ["WORKOUT_CONFLICT", "CONFLICT"], ["WORKOUT_INPUT_INVALID", "INVALID_INPUT"],
  ])("maps safe database error %s", async (message, code) => {
    const query = vi.fn().mockRejectedValue(new Error(message));
    await expect(getTrainerWorkout(token, workout.id, query))
      .rejects.toMatchObject({ code } as Partial<TrainerWorkoutError>);
  });
});
