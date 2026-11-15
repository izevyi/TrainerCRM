import { describe, expect, it, vi } from "vitest";
import { createWorkoutsHandlers, validWorkoutInput, WORKOUT_BODY_MAX_BYTES } from "./handler";

const token = Buffer.alloc(32, 4).toString("base64url");
const body = {
  clientId: "20000000-0000-4000-8000-000000000001", appointmentId: null,
  date: "2026-11-15", time: "10:30", type: "Personal training", completed: false,
  caloriesBurned: null, exercises: [{ name: "Squat", sets: [{ weight: 40.5, reps: 12 }] }],
};
const request = (method: string, value?: unknown) => new Request("http://localhost/api/workouts", {
  method, headers: { cookie: `trainercrm_session=${token}`, "content-type": "application/json" },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});

describe("workout collection API", () => {
  it("validates the exact bounded legacy aggregate", () => {
    expect(validWorkoutInput(body)).toBe(true);
    expect(validWorkoutInput({ ...body, trainerId: crypto.randomUUID() })).toBe(false);
    expect(validWorkoutInput({ ...body, date: "2026-02-31" })).toBe(false);
    expect(validWorkoutInput({ ...body, exercises: [{ name: "x", sets: [{ weight: 40.25, reps: 1 }] }] })).toBe(false);
    expect(validWorkoutInput({ ...body, exercises: [{ name: "x", sets: [{ weight: 40.5, reps: 1.5 }] }] })).toBe(false);
    expect(validWorkoutInput({ ...body, exercises: Array.from({ length: 51 }, () => ({ name: "x", sets: [] })) })).toBe(false);
  });

  it("requires a session before database work", async () => {
    const resolve = vi.fn(); const list = vi.fn();
    const response = await createWorkoutsHandlers(resolve, list).GET(new Request("http://localhost/api/workouts"));
    expect(response.status).toBe(401); expect(resolve).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });

  it("creates after session validation and returns no-store", async () => {
    const resolve = vi.fn().mockResolvedValue({}); const create = vi.fn().mockResolvedValue({ id: "workout" });
    const response = await createWorkoutsHandlers(resolve, vi.fn(), create).POST(request("POST", body));
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(create).toHaveBeenCalledWith(token, body);
  });

  it("rejects malformed and oversized bodies", async () => {
    const handlers = createWorkoutsHandlers(vi.fn(), vi.fn(), vi.fn());
    expect((await handlers.POST(request("POST", { ...body, completed: "yes" }))).status).toBe(400);
    const oversized = new Request("http://localhost/api/workouts", { method: "POST",
      headers: { cookie: `trainercrm_session=${token}` }, body: "x".repeat(WORKOUT_BODY_MAX_BYTES + 1) });
    expect((await handlers.POST(oversized)).status).toBe(400);
  });
});
