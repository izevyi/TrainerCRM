export type ServerClient = Readonly<{
  id: string;
  name: string;
  startingWeight: number;
  createdAt: string;
}>;

export type ClientRequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "validation"; fieldErrors: { name?: string; startingWeight?: string } }
  | { ok: false; kind: "unauthorized" | "unavailable" | "network" | "aborted" };

type Fetcher = typeof fetch;

function isServerClient(value: unknown): value is ServerClient {
  return typeof value === "object" && value !== null &&
    typeof (value as ServerClient).id === "string" &&
    typeof (value as ServerClient).name === "string" &&
    typeof (value as ServerClient).startingWeight === "number" &&
    typeof (value as ServerClient).createdAt === "string";
}

async function responseError(response: Response): Promise<ClientRequestResult<never>> {
  if (response.status === 401) return { ok: false, kind: "unauthorized" };
  if (response.status === 400) {
    let body: unknown;
    try { body = await response.json(); } catch { body = null; }
    const raw = typeof body === "object" && body !== null && "fieldErrors" in body
      ? (body as { fieldErrors?: unknown }).fieldErrors
      : null;
    const errors = typeof raw === "object" && raw !== null
      ? raw as { name?: unknown; startingWeight?: unknown }
      : {};
    return {
      ok: false,
      kind: "validation",
      fieldErrors: {
        name: typeof errors.name === "string" ? errors.name : undefined,
        startingWeight: typeof errors.startingWeight === "string" ? errors.startingWeight : undefined,
      },
    };
  }
  return { ok: false, kind: "unavailable" };
}

export async function listClients(
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<ClientRequestResult<ServerClient[]>> {
  try {
    const response = await fetcher("/api/clients", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok) return responseError(response);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("clients" in body) ||
        !Array.isArray(body.clients) || !body.clients.every(isServerClient)) {
      return { ok: false, kind: "unavailable" };
    }
    return { ok: true, value: body.clients };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return { ok: false, kind: "aborted" };
    }
    return { ok: false, kind: "network" };
  }
}

export async function postClient(
  name: string,
  startingWeight: number,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<ClientRequestResult<ServerClient>> {
  try {
    const response = await fetcher("/api/clients", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, startingWeight }),
      signal,
    });
    if (!response.ok) return responseError(response);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("client" in body) || !isServerClient(body.client)) {
      return { ok: false, kind: "unavailable" };
    }
    return { ok: true, value: body.client };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return { ok: false, kind: "aborted" };
    }
    return { ok: false, kind: "network" };
  }
}
