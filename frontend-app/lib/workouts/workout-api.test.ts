import { describe, expect, it, vi } from "vitest";
import { listWorkouts, saveWorkout, type WorkoutInput } from "./workout-api";

const workout = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", clientId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  clientName: "Анна", appointmentId: null, date: "2026-11-15", time: "09:00:00",
  type: "Персональная тренировка", completed: true, caloriesBurned: null,
  createdAt: "2026-11-15T09:00:00Z", updatedAt: "2026-11-15T09:00:00Z",
  exercises: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Приседания", sets: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", weight: 50, reps: 10 }] }],
};
const input: WorkoutInput = { clientId: workout.clientId, appointmentId: null, date: workout.date, time: "09:00", type: workout.type, completed: true, caloriesBurned: null, exercises: [{ name: "Приседания", sets: [{ weight: 50, reps: 10 }] }] };
const response = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

describe("workout browser API", () => {
  it("loads one client's history using only the authenticated cookie", async () => {
    const fetcher = response(200, { workouts: [workout] });
    await expect(listWorkouts(workout.clientId, fetcher)).resolves.toEqual({ ok: true, value: [workout] });
    expect(fetcher).toHaveBeenCalledWith(`/api/workouts?clientId=${workout.clientId}`, { method: "GET", credentials: "same-origin", cache: "no-store", signal: undefined });
    expect(vi.mocked(fetcher).mock.calls[0][0]).not.toContain("trainerId");
  });

  it("creates and updates workouts without browser-supplied trainer identity", async () => {
    const create = response(201, { workout });
    await expect(saveWorkout(input, undefined, create)).resolves.toEqual({ ok: true, value: workout });
    expect(vi.mocked(create).mock.calls[0][0]).toBe("/api/workouts");
    expect(vi.mocked(create).mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(String(vi.mocked(create).mock.calls[0][1]?.body)).not.toMatch(/trainerId|tenantId/);
    const update = response(200, { workout });
    await expect(saveWorkout(input, workout.id, update)).resolves.toEqual({ ok: true, value: workout });
    expect(vi.mocked(update).mock.calls[0][0]).toBe(`/api/workouts/${workout.id}`);
    expect(vi.mocked(update).mock.calls[0][1]).toMatchObject({ method: "PUT" });
  });

  it.each([[401, "unauthorized"], [400, "validation"], [404, "not-found"], [409, "conflict"], [503, "unavailable"]] as const)("maps HTTP %s to %s", async (status, kind) => {
    await expect(listWorkouts(workout.clientId, response(status, {}))).resolves.toEqual({ ok: false, kind });
  });

  it("rejects malformed success data and distinguishes network failures", async () => {
    await expect(listWorkouts(workout.clientId, response(200, { workouts: [{ id: "bad" }] }))).resolves.toEqual({ ok: false, kind: "unavailable" });
    const offline = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(saveWorkout(input, undefined, offline)).resolves.toEqual({ ok: false, kind: "network" });
  });
});
