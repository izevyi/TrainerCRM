import { describe, expect, it } from "vitest";

import type { TrainerCrmData } from "../lib/domain/trainer-crm";
import { createClient } from "./client-creation";

function dataWith(clientIds: number[] = [2, 5]): TrainerCrmData {
  return {
    clients: clientIds.map((id) => ({
      id,
      name: `Клиент ${id}`,
      weight: 70,
      startWeight: 72,
    })),
    trainings: [{
      id: 11,
      clientId: clientIds[0] ?? 1,
      clientName: "Связанный клиент",
      date: "2026-11-06",
      time: "10:00",
      type: "Персональная тренировка",
      completed: false,
    }],
    exercises: {
      11: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 30, reps: 10 }] }],
    },
  };
}

describe("createClient", () => {
  it("creates a valid client with equal current and starting weights", () => {
    const result = createClient(dataWith(), { name: "Анна", startingWeight: "68.5" });

    expect(result).toMatchObject({
      ok: true,
      client: { id: 6, name: "Анна", weight: 68.5, startWeight: 68.5 },
    });
  });

  it("trims the client name", () => {
    const result = createClient(dataWith(), { name: "  Анна Петрова  ", startingWeight: "70" });

    expect(result.ok && result.client.name).toBe("Анна Петрова");
  });

  it.each(["", "   "])("rejects an empty name %j with a useful error", (name) => {
    const result = createClient(dataWith(), { name, startingWeight: "70" });

    expect(result).toEqual({ ok: false, fieldErrors: { name: "Введите имя клиента." } });
  });

  it("rejects names longer than 120 trimmed characters", () => {
    const result = createClient(dataWith(), { name: ` ${"я".repeat(121)} `, startingWeight: "70" });

    expect(result).toEqual({
      ok: false,
      fieldErrors: { name: "Имя должно содержать не более 120 символов." },
    });
  });

  it.each(["", "0", "-1", "NaN", "Infinity", "1e999", "не число"])(
    "rejects invalid starting weight %j",
    (startingWeight) => {
      const result = createClient(dataWith(), { name: "Анна", startingWeight });

      expect(result).toEqual({
        ok: false,
        fieldErrors: { startingWeight: "Введите положительный вес числом." },
      });
    },
  );

  it("uses an ID after the highest existing client without assuming a list size", () => {
    const result = createClient(dataWith([3, 40, 9]), { name: "Анна", startingWeight: "70" });

    expect(result.ok && result.client.id).toBe(41);
  });

  it("avoids collisions when existing IDs are sparse and duplicated", () => {
    const result = createClient(dataWith([1, 3, 3, 8]), { name: "Анна", startingWeight: "70" });

    expect(result.ok && result.client.id).toBe(9);
  });

  it("stays within safe integer limits when the maximum safe ID exists", () => {
    const result = createClient(dataWith([1, Number.MAX_SAFE_INTEGER]), {
      name: "Анна",
      startingWeight: "70",
    });

    expect(result.ok && result.client.id).toBe(2);
    expect(result.ok && Number.isSafeInteger(result.client.id)).toBe(true);
  });

  it("does not mutate existing clients or relationship data", () => {
    const original = dataWith([2, 5]);
    const snapshot = structuredClone(original);
    const result = createClient(original, { name: "Анна", startingWeight: "70" });

    expect(original).toEqual(snapshot);
    expect(result.ok && result.data.clients.slice(0, -1)).toEqual(original.clients);
    expect(result.ok && result.data.trainings).toBe(original.trainings);
    expect(result.ok && result.data.exercises).toBe(original.exercises);
    expect(result.ok && result.data.trainings[0].clientId).toBe(2);
  });

  it("returns all applicable field errors", () => {
    expect(createClient(dataWith(), { name: " ", startingWeight: "-2" })).toEqual({
      ok: false,
      fieldErrors: {
        name: "Введите имя клиента.",
        startingWeight: "Введите положительный вес числом.",
      },
    });
  });
});
