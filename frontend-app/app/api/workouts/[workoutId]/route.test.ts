import { describe, expect, it, vi } from "vitest";
import { createWorkoutHandlers } from "./handler";

const token = Buffer.alloc(32, 3).toString("base64url");
const id = "30000000-0000-4000-8000-000000000001";
const body = { clientId: "20000000-0000-4000-8000-000000000001", appointmentId: null,
  date: "2026-11-15", time: "10:30", type: "Personal", completed: true,
  caloriesBurned: 250, exercises: [] };
const context = { params: Promise.resolve({ workoutId: id }) };

describe("workout item API", () => {
  it("retrieves and updates an authenticated workout", async () => {
    const resolve = vi.fn().mockResolvedValue({}); const get = vi.fn().mockResolvedValue({ id });
    const update = vi.fn().mockResolvedValue({ id }); const handlers = createWorkoutHandlers(resolve, get, update);
    const headers = { cookie: `trainercrm_session=${token}`, "content-type": "application/json" };
    expect((await handlers.GET(new Request(`http://localhost/api/workouts/${id}`, { headers }), context)).status).toBe(200);
    expect((await handlers.PUT(new Request(`http://localhost/api/workouts/${id}`, { method: "PUT", headers, body: JSON.stringify(body) }), context)).status).toBe(200);
    expect(get).toHaveBeenCalledWith(token, id); expect(update).toHaveBeenCalledWith(token, id, body);
  });

  it("hides malformed identifiers as not found", async () => {
    const response = await createWorkoutHandlers().GET(
      new Request("http://localhost/api/workouts/nope", { headers: { cookie: `trainercrm_session=${token}` } }),
      { params: Promise.resolve({ workoutId: "nope" }) },
    );
    expect(response.status).toBe(404);
  });
});
