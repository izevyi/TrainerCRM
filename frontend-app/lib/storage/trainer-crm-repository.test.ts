import { describe, expect, it } from "vitest";

import type { TrainerCrmData } from "../domain/trainer-crm";
import {
  TRAINER_CRM_RECOVERY_SUFFIX,
  TRAINER_CRM_STORAGE_KEYS,
  TrainerCrmRepository,
  type StoragePort,
} from "./trainer-crm-repository";

const defaults: TrainerCrmData = {
  clients: [{ id: 1, name: "Default", weight: 70, startWeight: 75 }],
  trainings: [],
  exercises: {},
};
const stored: TrainerCrmData = {
  clients: [{ id: 2, name: "Мария", weight: 64.8, startWeight: 67.5 }],
  trainings: [{
    id: 8,
    clientId: 2,
    clientName: "Мария",
    date: "2026-09-01",
    time: "10:00",
    type: "Персональная",
    completed: false,
  }],
  exercises: { 8: [{ id: 1, name: "Тяга", sets: [{ id: 1, weight: 32.5, reps: 12 }] }] },
};

class FakeStorage implements StoragePort {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  readonly failingReads = new Set<string>();
  readonly failingWrites = new Set<string>();

  getItem(key: string): string | null {
    if (this.failingReads.has(key)) throw new Error(`read ${key}`);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push(key);
    if (this.failingWrites.has(key)) throw new Error(`write ${key}`);
    this.values.set(key, value);
  }
}

function seedLegacy(storage: FakeStorage): void {
  storage.values.set(TRAINER_CRM_STORAGE_KEYS.clients, JSON.stringify(stored.clients));
  storage.values.set(TRAINER_CRM_STORAGE_KEYS.trainings, JSON.stringify(stored.trainings));
  storage.values.set(TRAINER_CRM_STORAGE_KEYS.exercises, JSON.stringify(stored.exercises));
}

describe("TrainerCrmRepository", () => {
  it("loads legacy data without writing and marks each slice for migration", () => {
    const storage = new FakeStorage();
    seedLegacy(storage);

    const result = new TrainerCrmRepository(storage).load(defaults);

    expect(result.data).toEqual(stored);
    expect(result.needsMigration).toEqual(["clients", "trainings", "exercises"]);
    expect(storage.writes).toEqual([]);
  });

  it("uses only the missing slice default", () => {
    const storage = new FakeStorage();
    seedLegacy(storage);
    storage.values.delete(TRAINER_CRM_STORAGE_KEYS.clients);

    const result = new TrainerCrmRepository(storage).load(defaults);

    expect(result.data.clients).toEqual(defaults.clients);
    expect(result.data.trainings).toEqual(stored.trainings);
    expect(result.issues).toEqual([]);
  });

  it("isolates malformed data and copies its exact bytes to a fixed recovery slot", () => {
    const storage = new FakeStorage();
    seedLegacy(storage);
    storage.values.set(TRAINER_CRM_STORAGE_KEYS.clients, "{bad json");

    const result = new TrainerCrmRepository(storage).load(defaults);

    expect(result.data.clients).toEqual(defaults.clients);
    expect(result.data.trainings).toEqual(stored.trainings);
    expect(result.issues[0]).toMatchObject({ slice: "clients", kind: "parse-error" });
    expect(result.recoveredSlices).toEqual(["clients"]);
    expect(storage.values.get(`${TRAINER_CRM_STORAGE_KEYS.clients}${TRAINER_CRM_RECOVERY_SUFFIX}`)).toBe("{bad json");
  });

  it("keeps future versions protected even after recovery", () => {
    const storage = new FakeStorage();
    const future = JSON.stringify({ schemaVersion: 2, data: stored.clients });
    storage.values.set(TRAINER_CRM_STORAGE_KEYS.clients, future);
    const repository = new TrainerCrmRepository(storage);

    const loaded = repository.load(defaults);
    const saved = repository.save(stored);

    expect(loaded.blockedSlices).toEqual(["clients"]);
    expect(saved.slices.find(({ slice }) => slice === "clients")?.status).toBe("blocked");
    expect(storage.values.get(TRAINER_CRM_STORAGE_KEYS.clients)).toBe(future);
  });

  it("blocks overwrite when recovery fails or its bounded slot is occupied", () => {
    const storage = new FakeStorage();
    const key = TRAINER_CRM_STORAGE_KEYS.clients;
    storage.values.set(key, "bad");
    storage.values.set(`${key}${TRAINER_CRM_RECOVERY_SUFFIX}`, "earlier bad data");
    const repository = new TrainerCrmRepository(storage);

    const loaded = repository.load(defaults);
    const saved = repository.save(stored);

    expect(loaded.issues.some(({ kind }) => kind === "recovery-error")).toBe(true);
    expect(loaded.blockedSlices).toEqual(["clients"]);
    expect(saved.slices.find(({ slice }) => slice === "clients")?.status).toBe("blocked");
    expect(storage.values.get(key)).toBe("bad");
  });

  it("round-trips v1 using exactly the three source keys", () => {
    const storage = new FakeStorage();
    const repository = new TrainerCrmRepository(storage);

    expect(repository.save(stored).ok).toBe(true);
    expect(storage.writes).toEqual(Object.values(TRAINER_CRM_STORAGE_KEYS));
    expect(repository.load(defaults).data).toEqual(stored);
    for (const key of Object.values(TRAINER_CRM_STORAGE_KEYS)) {
      expect(JSON.parse(storage.values.get(key)!)).toMatchObject({ schemaVersion: 1 });
    }
  });

  it("persists recorded calories and preserves clearing after reload", () => {
    const storage = new FakeStorage();
    const repository = new TrainerCrmRepository(storage);
    const withCalories: TrainerCrmData = {
      ...stored,
      trainings: [{ ...stored.trainings[0], caloriesBurned: 321.5 }],
    };

    expect(repository.save(withCalories).ok).toBe(true);
    expect(new TrainerCrmRepository(storage).load(defaults).data.trainings[0])
      .toMatchObject({ caloriesBurned: 321.5 });

    expect(repository.save(stored).ok).toBe(true);
    const reloaded = new TrainerCrmRepository(storage).load(defaults);
    expect(reloaded.data.trainings[0]).not.toHaveProperty("caloriesBurned");
    expect(storage.values.size).toBe(3);
    expect(
      JSON.parse(storage.values.get(TRAINER_CRM_STORAGE_KEYS.trainings)!)
        .schemaVersion,
    ).toBe(1);
  });

  it("reports partial writes and continues after one storage failure", () => {
    const storage = new FakeStorage();
    storage.failingWrites.add(TRAINER_CRM_STORAGE_KEYS.trainings);

    const result = new TrainerCrmRepository(storage).save(stored);

    expect(result.ok).toBe(false);
    expect(result.slices.map(({ status }) => status)).toEqual(["saved", "failed", "saved"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ slice: "trainings", kind: "write-error" });
  });

  it("aborts all writes when any slice fails preflight validation", () => {
    const storage = new FakeStorage();
    const invalid = { ...stored, clients: [{ ...stored.clients[0], weight: Infinity }] };

    const result = new TrainerCrmRepository(storage).save(invalid);

    expect(result.ok).toBe(false);
    expect(storage.writes).toEqual([]);
    expect(result.issues[0]).toMatchObject({ slice: "clients", kind: "serialization-error" });
  });

  it("isolates a read failure and protects the unread slice", () => {
    const storage = new FakeStorage();
    seedLegacy(storage);
    storage.failingReads.add(TRAINER_CRM_STORAGE_KEYS.clients);
    const repository = new TrainerCrmRepository(storage);

    const loaded = repository.load(defaults);

    expect(loaded.data.clients).toEqual(defaults.clients);
    expect(loaded.data.trainings).toEqual(stored.trainings);
    expect(loaded.issues[0]).toMatchObject({ slice: "clients", kind: "read-error" });
    expect(repository.save(stored).slices[0].status).toBe("blocked");
  });
});
