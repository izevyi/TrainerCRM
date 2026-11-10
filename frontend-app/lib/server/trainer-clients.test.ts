import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createTrainerClient, listTrainerClients } from "./trainer-clients";

const token = Buffer.alloc(32, 1).toString("base64url");
const row = { client_id: "id", display_name: "Анна", starting_weight: "65.250", created_at: "2026-02-03T04:05:06Z" };

describe("trainer client database adapter", () => {
  it("uses a parameterized, session-bound list function", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] });
    await expect(listTrainerClients(token, query)).resolves.toEqual([
      { id: "id", name: "Анна", startingWeight: 65.25, createdAt: "2026-02-03T04:05:06.000Z" },
    ]);
    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM booking.list_trainer_clients($1::bytea)",
      [createHash("sha256").update(Buffer.alloc(32, 1)).digest()],
    );
  });

  it("passes no trainer or tenant identifier to create", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] });
    await createTrainerClient(token, "Анна", 65.25, query);
    expect(query.mock.calls[0][0]).toBe(
      "SELECT * FROM booking.create_trainer_client($1::bytea, $2::text, $3::numeric)",
    );
    expect(query.mock.calls[0][1]).toHaveLength(3);
  });
});
