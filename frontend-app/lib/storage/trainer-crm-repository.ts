import type { TrainerCrmData } from "../domain/trainer-crm";
import {
  decodeSlice,
  isClients,
  isTrainingExercises,
  isTrainings,
  normalizeOwnedReferences,
  serializeSlice,
} from "./schema";

export const TRAINER_CRM_STORAGE_KEYS = {
  clients: "trainercrm_clients",
  trainings: "trainercrm_trainings",
  exercises: "trainercrm_exercises",
} as const;

export const TRAINER_CRM_RECOVERY_SUFFIX = ".recovery";

export type TrainerCrmSlice = keyof typeof TRAINER_CRM_STORAGE_KEYS;

export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type RepositoryIssue = {
  slice: TrainerCrmSlice;
  kind:
    | "read-error"
    | "parse-error"
    | "invalid-shape"
    | "unsupported-version"
    | "recovery-error"
    | "serialization-error"
    | "write-error";
  message: string;
  version?: number;
};

export type LoadResult = {
  data: TrainerCrmData;
  issues: RepositoryIssue[];
  needsMigration: TrainerCrmSlice[];
  recoveredSlices: TrainerCrmSlice[];
  blockedSlices: TrainerCrmSlice[];
  removedExerciseTrainingIds: number[];
  danglingClientTrainingIds: number[];
};

export type SaveSliceResult = {
  slice: TrainerCrmSlice;
  key: string;
  status: "saved" | "blocked" | "failed";
};

export type SaveResult = {
  ok: boolean;
  slices: SaveSliceResult[];
  issues: RepositoryIssue[];
};

type TrainerCrmSliceData = TrainerCrmData[TrainerCrmSlice];

const sliceGuards: Record<
  TrainerCrmSlice,
  (value: unknown) => value is TrainerCrmSliceData
> = {
  clients: isClients,
  trainings: isTrainings,
  exercises: isTrainingExercises,
};

const slices = Object.keys(TRAINER_CRM_STORAGE_KEYS) as TrainerCrmSlice[];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TrainerCrmRepository {
  private readonly blockedSlices = new Set<TrainerCrmSlice>();

  constructor(private readonly storage: StoragePort) {}

  load(defaults: TrainerCrmData): LoadResult {
    const data: TrainerCrmData = {
      clients: defaults.clients,
      trainings: defaults.trainings,
      exercises: defaults.exercises,
    };
    const issues: RepositoryIssue[] = [];
    const needsMigration: TrainerCrmSlice[] = [];
    const recoveredSlices: TrainerCrmSlice[] = [];
    this.blockedSlices.clear();

    for (const slice of slices) {
      const key = TRAINER_CRM_STORAGE_KEYS[slice];
      let raw: string | null;
      try {
        raw = this.storage.getItem(key);
      } catch (error) {
        issues.push({ slice, kind: "read-error", message: errorMessage(error) });
        this.blockedSlices.add(slice);
        continue;
      }

      if (raw === null) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        issues.push({ slice, kind: "parse-error", message: errorMessage(error) });
        this.recoverOrBlock(slice, raw, issues, recoveredSlices, false);
        continue;
      }

      const decoded = decodeSlice(parsed, sliceGuards[slice]);
      if (decoded.status === "legacy" || decoded.status === "v1") {
        Object.assign(data, { [slice]: decoded.data });
        if (decoded.needsMigration) needsMigration.push(slice);
        continue;
      }

      if (decoded.status === "unsupported-version") {
        issues.push({
          slice,
          kind: "unsupported-version",
          version: decoded.version,
          message: `Unsupported schema version ${decoded.version}`,
        });
      } else {
        issues.push({ slice, kind: "invalid-shape", message: "Invalid slice shape" });
      }
      this.recoverOrBlock(
        slice,
        raw,
        issues,
        recoveredSlices,
        decoded.status === "unsupported-version",
      );
    }

    const normalized = normalizeOwnedReferences(data);
    return {
      data: normalized.data,
      issues,
      needsMigration,
      recoveredSlices,
      blockedSlices: [...this.blockedSlices],
      removedExerciseTrainingIds: normalized.removedExerciseTrainingIds,
      danglingClientTrainingIds: normalized.danglingClientTrainingIds,
    };
  }

  save(data: TrainerCrmData): SaveResult {
    const issues: RepositoryIssue[] = [];
    const serialized = new Map<TrainerCrmSlice, string>();

    for (const slice of slices) {
      try {
        serialized.set(slice, serializeSlice(data[slice], sliceGuards[slice]));
      } catch (error) {
        issues.push({ slice, kind: "serialization-error", message: errorMessage(error) });
      }
    }

    if (issues.length > 0) {
      return {
        ok: false,
        issues,
        slices: slices.map((slice) => ({
          slice,
          key: TRAINER_CRM_STORAGE_KEYS[slice],
          status: "failed",
        })),
      };
    }

    const results: SaveSliceResult[] = [];
    for (const slice of slices) {
      const key = TRAINER_CRM_STORAGE_KEYS[slice];
      if (this.blockedSlices.has(slice)) {
        results.push({ slice, key, status: "blocked" });
        continue;
      }

      try {
        this.storage.setItem(key, serialized.get(slice)!);
        results.push({ slice, key, status: "saved" });
      } catch (error) {
        issues.push({ slice, kind: "write-error", message: errorMessage(error) });
        results.push({ slice, key, status: "failed" });
      }
    }

    return { ok: results.every(({ status }) => status === "saved"), slices: results, issues };
  }

  private recoverOrBlock(
    slice: TrainerCrmSlice,
    raw: string,
    issues: RepositoryIssue[],
    recoveredSlices: TrainerCrmSlice[],
    alwaysBlock: boolean,
  ): void {
    try {
      const recoveryKey = `${TRAINER_CRM_STORAGE_KEYS[slice]}${TRAINER_CRM_RECOVERY_SUFFIX}`;
      const existingRecovery = this.storage.getItem(recoveryKey);
      if (existingRecovery !== null && existingRecovery !== raw) {
        throw new Error("Recovery slot already contains different data");
      }
      if (existingRecovery === null) this.storage.setItem(recoveryKey, raw);
      recoveredSlices.push(slice);
      if (alwaysBlock) this.blockedSlices.add(slice);
    } catch (error) {
      issues.push({ slice, kind: "recovery-error", message: errorMessage(error) });
      this.blockedSlices.add(slice);
    }
  }
}
