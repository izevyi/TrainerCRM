export type WorkoutSet = Readonly<{ id: string; weight: number; reps: number }>;
export type WorkoutExercise = Readonly<{ id: string; name: string; sets: WorkoutSet[] }>;
export type WorkoutInput = Readonly<{
  clientId: string;
  appointmentId: string | null;
  date: string;
  time: string;
  type: string;
  completed: boolean;
  caloriesBurned: number | null;
  exercises: ReadonlyArray<{ name: string; sets: ReadonlyArray<{ weight: number; reps: number }> }>;
}>;
export type Workout = Readonly<Omit<WorkoutInput, "exercises"> & {
  id: string;
  clientName: string;
  createdAt: string;
  updatedAt: string;
  exercises: WorkoutExercise[];
}>;

export type WorkoutRequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "unauthorized" | "validation" | "not-found" | "conflict" | "unavailable" | "network" | "aborted" };

type Fetcher = typeof fetch;

function isSet(value: unknown): value is WorkoutSet {
  return typeof value === "object" && value !== null && typeof (value as WorkoutSet).id === "string" &&
    typeof (value as WorkoutSet).weight === "number" && typeof (value as WorkoutSet).reps === "number";
}

function isExercise(value: unknown): value is WorkoutExercise {
  return typeof value === "object" && value !== null && typeof (value as WorkoutExercise).id === "string" &&
    typeof (value as WorkoutExercise).name === "string" && Array.isArray((value as WorkoutExercise).sets) &&
    (value as WorkoutExercise).sets.every(isSet);
}

function isWorkout(value: unknown): value is Workout {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Workout;
  return typeof item.id === "string" && typeof item.clientId === "string" && typeof item.clientName === "string" &&
    (item.appointmentId === null || typeof item.appointmentId === "string") && typeof item.date === "string" &&
    typeof item.time === "string" && typeof item.type === "string" && typeof item.completed === "boolean" &&
    (item.caloriesBurned === null || typeof item.caloriesBurned === "number") && typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string" && Array.isArray(item.exercises) && item.exercises.every(isExercise);
}

async function failure(response: Response): Promise<WorkoutRequestResult<never>> {
  if (response.status === 401) return { ok: false, kind: "unauthorized" };
  if (response.status === 400) return { ok: false, kind: "validation" };
  if (response.status === 404) return { ok: false, kind: "not-found" };
  if (response.status === 409) return { ok: false, kind: "conflict" };
  return { ok: false, kind: "unavailable" };
}

async function request<T>(url: string, init: RequestInit, read: (body: unknown) => T | null, fetcher: Fetcher): Promise<WorkoutRequestResult<T>> {
  try {
    const response = await fetcher(url, { credentials: "same-origin", cache: "no-store", ...init });
    if (!response.ok) return failure(response);
    const value = read(await response.json());
    return value === null ? { ok: false, kind: "unavailable" } : { ok: true, value };
  } catch (error) {
    if (init.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return { ok: false, kind: "aborted" };
    return { ok: false, kind: "network" };
  }
}

export function listWorkouts(clientId: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  return request(`/api/workouts?clientId=${encodeURIComponent(clientId)}`, { method: "GET", signal }, (body) => {
    const workouts = typeof body === "object" && body !== null && "workouts" in body ? (body as { workouts: unknown }).workouts : null;
    return Array.isArray(workouts) && workouts.every(isWorkout) ? workouts : null;
  }, fetcher);
}

export function saveWorkout(input: WorkoutInput, workoutId?: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  return request(workoutId ? `/api/workouts/${encodeURIComponent(workoutId)}` : "/api/workouts", {
    method: workoutId ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }, (body) => {
    const workout = typeof body === "object" && body !== null && "workout" in body ? (body as { workout: unknown }).workout : null;
    return isWorkout(workout) ? workout : null;
  }, fetcher);
}
