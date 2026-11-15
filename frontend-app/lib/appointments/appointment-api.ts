export type ServerAppointment = Readonly<{
  id: string; clientId: string; clientName?: string; startsAt: string; endsAt: string;
  status: "active" | "cancelled"; cancelledAt: string | null; createdAt: string; updatedAt: string;
}>;

export type AppointmentErrorKind = "validation" | "unauthorized" | "not-found" | "conflict" | "unavailable" | "network" | "aborted";
export type AppointmentResult<T> = { ok: true; value: T } | { ok: false; kind: AppointmentErrorKind };
type Fetcher = typeof fetch;

function isAppointment(value: unknown): value is ServerAppointment {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ServerAppointment>;
  return typeof item.id === "string" && typeof item.clientId === "string" &&
    (item.clientName === undefined || typeof item.clientName === "string") &&
    typeof item.startsAt === "string" && Number.isFinite(Date.parse(item.startsAt)) &&
    typeof item.endsAt === "string" && Number.isFinite(Date.parse(item.endsAt)) &&
    (item.status === "active" || item.status === "cancelled") &&
    (item.cancelledAt === null || typeof item.cancelledAt === "string") &&
    typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

async function failure(response: Response): Promise<AppointmentResult<never>> {
  if (response.status === 400) return { ok: false, kind: "validation" };
  if (response.status === 401 || response.status === 403) return { ok: false, kind: "unauthorized" };
  if (response.status === 404) return { ok: false, kind: "not-found" };
  if (response.status === 409) return { ok: false, kind: "conflict" };
  return { ok: false, kind: "unavailable" };
}

async function request<T>(url: string, init: RequestInit, extract: (body: Record<string, unknown>) => T | null, fetcher: Fetcher): Promise<AppointmentResult<T>> {
  try {
    const response = await fetcher(url, { credentials: "same-origin", cache: "no-store", ...init });
    if (!response.ok) return failure(response);
    const body: unknown = await response.json();
    const value = typeof body === "object" && body !== null && !Array.isArray(body) ? extract(body as Record<string, unknown>) : null;
    return value === null ? { ok: false, kind: "unavailable" } : { ok: true, value };
  } catch (error) {
    if (init.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return { ok: false, kind: "aborted" };
    return { ok: false, kind: "network" };
  }
}

export function listAppointments(from: string, to: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  const query = new URLSearchParams({ from, to });
  return request(`/api/appointments?${query}`, { method: "GET", signal }, (body) => {
    const items = body.appointments;
    return Array.isArray(items) && items.every(isAppointment) ? items : null;
  }, fetcher);
}

export function createAppointment(clientId: string, startsAt: string, endsAt: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  return request("/api/appointments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, startsAt, endsAt }), signal },
    (body) => isAppointment(body.appointment) ? body.appointment : null, fetcher);
}

export function rescheduleAppointment(id: string, startsAt: string, endsAt: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  return request(`/api/appointments/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startsAt, endsAt }), signal },
    (body) => isAppointment(body.appointment) ? body.appointment : null, fetcher);
}

export function cancelAppointment(id: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  return request(`/api/appointments/${encodeURIComponent(id)}`, { method: "DELETE", signal },
    (body) => isAppointment(body.appointment) ? body.appointment : null, fetcher);
}
