export type ServerWeight = Readonly<{ id: string; date: string; weight: number; createdAt: string }>;
export type WeightRequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "unauthorized" | "not-found" | "validation" | "conflict" | "unavailable" | "network" | "aborted" };

type Fetcher = typeof fetch;
const uri = (clientId: string) => `/api/clients/${encodeURIComponent(clientId)}/weights`;
const isWeight = (raw: unknown): raw is ServerWeight => {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Record<string, unknown>;
  return typeof value.id === "string" && typeof value.date === "string" &&
    typeof value.weight === "number" && Number.isFinite(value.weight) &&
    typeof value.createdAt === "string";
};

async function request<T>(
  clientId: string, init: RequestInit, parse: (body: unknown) => T | null, fetcher: Fetcher,
): Promise<WeightRequestResult<T>> {
  try {
    const response = await fetcher(uri(clientId), { ...init, credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const kind = ({ 400: "validation", 401: "unauthorized", 404: "not-found", 409: "conflict" } as const)[response.status as 400 | 401 | 404 | 409] ?? "unavailable";
      return { ok: false, kind };
    }
    const value = parse(await response.json());
    return value === null ? { ok: false, kind: "unavailable" } : { ok: true, value };
  } catch (error) {
    if (init.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return { ok: false, kind: "aborted" };
    return { ok: false, kind: "network" };
  }
}

export function listWeights(clientId: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  return request(clientId, { method: "GET", signal }, body => {
    const values = body && typeof body === "object" && "measurements" in body ? body.measurements : null;
    return Array.isArray(values) && values.every(isWeight) ? values as ServerWeight[] : null;
  }, fetcher);
}

export function saveWeight(clientId: string, date: string, weight: number, id: string | null = null, fetcher: Fetcher = fetch) {
  return request(clientId, {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(id ? { id, date, weight } : { date, weight }),
  }, body => {
    const value = body && typeof body === "object" && "measurement" in body ? body.measurement : null;
    return isWeight(value) ? value : null;
  }, fetcher);
}

export function deleteWeight(clientId: string, id: string, fetcher: Fetcher = fetch) {
  return request(clientId, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
  }, body => body && typeof body === "object" && "deleted" in body && body.deleted === true ? true : null, fetcher);
}
