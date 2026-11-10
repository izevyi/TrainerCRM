import { describe, expect, it, vi } from "vitest";

import { listClients, postClient } from "./client-api";

const client = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Анна Петрова",
  startingWeight: 72.5,
  createdAt: "2026-11-10T00:00:00.000Z",
};

function response(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
}

describe("trainer client browser API", () => {
  it("loads an empty server list with same-origin authentication", async () => {
    const fetcher = response(200, { clients: [] });
    await expect(listClients(fetcher)).resolves.toEqual({ ok: true, value: [] });
    expect(fetcher).toHaveBeenCalledWith("/api/clients", {
      method: "GET", credentials: "same-origin", cache: "no-store",
    });
  });

  it("lists and creates server clients without tenant identifiers", async () => {
    await expect(listClients(response(200, { clients: [client] })))
      .resolves.toEqual({ ok: true, value: [client] });
    const fetcher = response(201, { client });
    await expect(postClient("Анна Петрова", 72.5, fetcher))
      .resolves.toEqual({ ok: true, value: client });
    const init = vi.mocked(fetcher).mock.calls[0][1];
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Анна Петрова", startingWeight: 72.5 });
    expect(String(init?.body)).not.toMatch(/trainerId|tenantId/);
  });

  it("returns validation fields from HTTP 400", async () => {
    await expect(postClient("", 0, response(400, {
      error: "INVALID_INPUT",
      fieldErrors: { name: "Name is required.", startingWeight: "Invalid weight." },
    }))).resolves.toEqual({
      ok: false,
      kind: "validation",
      fieldErrors: { name: "Name is required.", startingWeight: "Invalid weight." },
    });
  });

  it.each([
    {},
    { error: "INVALID_INPUT" },
    { fieldErrors: { unknown: "Invalid value." } },
    { fieldErrors: "invalid" },
  ])("keeps a bare or unrecognized HTTP 400 as a general validation result", async (body) => {
    await expect(postClient("Анна", 72, response(400, body))).resolves.toEqual({
      ok: false,
      kind: "validation",
      fieldErrors: { name: undefined, startingWeight: undefined },
    });
  });

  it("distinguishes unavailable service, network failure, and expired authentication", async () => {
    await expect(listClients(response(503, { error: "CLIENTS_UNAVAILABLE" })))
      .resolves.toEqual({ ok: false, kind: "unavailable" });
    await expect(listClients(response(401, { error: "UNAUTHORIZED" })))
      .resolves.toEqual({ ok: false, kind: "unauthorized" });
    const offline = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(listClients(offline)).resolves.toEqual({ ok: false, kind: "network" });
    await expect(postClient("Анна", 72, response(503, { error: "CLIENTS_UNAVAILABLE" })))
      .resolves.toEqual({ ok: false, kind: "unavailable" });
    await expect(postClient("Анна", 72, offline))
      .resolves.toEqual({ ok: false, kind: "network" });
  });

  it("passes abort signals to GET and POST and distinguishes cancellation from network errors", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;

    await expect(listClients(aborted, controller.signal)).resolves.toEqual({ ok: false, kind: "aborted" });
    await expect(postClient("Анна", 72, aborted, controller.signal)).resolves.toEqual({ ok: false, kind: "aborted" });
  });

  it("rejects malformed success data instead of displaying stale or local data", async () => {
    await expect(listClients(response(200, { clients: [{ id: 1, name: "local" }] })))
      .resolves.toEqual({ ok: false, kind: "unavailable" });
  });
});
