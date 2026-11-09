export type TrainerSession = Readonly<{
  trainerId: string;
  emailIdentityId: string;
  tenantId: string;
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}>;

export type AuthResult =
  | { ok: true; trainer: TrainerSession }
  | { ok: false; kind: "unauthorized" | "rate-limited" | "unavailable" };

type Fetcher = typeof fetch;

async function request(
  input: string,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<AuthResult> {
  try {
    const response = await fetcher(input, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init.headers },
    });

    if (response.ok) {
      const body: unknown = await response.json();
      if (
        typeof body === "object" && body !== null && "trainer" in body &&
        typeof body.trainer === "object" && body.trainer !== null
      ) {
        return { ok: true, trainer: body.trainer as TrainerSession };
      }
      return { ok: false, kind: "unavailable" };
    }
    if (response.status === 401) return { ok: false, kind: "unauthorized" };
    if (response.status === 429) return { ok: false, kind: "rate-limited" };
    return { ok: false, kind: "unavailable" };
  } catch {
    return { ok: false, kind: "unavailable" };
  }
}

export function verifySession(fetcher: Fetcher = fetch): Promise<AuthResult> {
  return request("/api/auth/me", { method: "GET", cache: "no-store" }, fetcher);
}

export function login(
  email: string,
  password: string,
  fetcher: Fetcher = fetch,
): Promise<AuthResult> {
  return request(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
    fetcher,
  );
}

export async function logout(fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const response = await fetcher("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}
