import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkDatabaseHealth } = vi.hoisted(() => ({
  checkDatabaseHealth: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ checkDatabaseHealth }));

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    checkDatabaseHealth.mockReset();
  });

  it("returns a generic success response when PostgreSQL is healthy", async () => {
    checkDatabaseHealth.mockResolvedValue(true);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns a generic unavailable response when PostgreSQL is unhealthy", async () => {
    checkDatabaseHealth.mockResolvedValue(false);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("does not expose database credentials or server details", async () => {
    const secrets = [
      "postgresql://admin:password@database.internal/trainercrm",
      "admin",
      "trainercrm",
      "database.internal",
      "ECONNREFUSED",
    ];
    checkDatabaseHealth.mockResolvedValue(false);

    const response = await GET();
    const body = await response.text();

    for (const secret of secrets) {
      expect(body).not.toContain(secret);
    }
  });
});
