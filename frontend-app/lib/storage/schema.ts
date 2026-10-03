import {
  TRAINER_CRM_SCHEMA_VERSION,
  type Client,
  type Exercise,
  type ExerciseSet,
  type TrainerCrmData,
  type TrainerCrmSnapshotV1,
  type Training,
  type TrainingExercises,
} from "../domain/trainer-crm";

type Guard<T> = (value: unknown) => value is T;

export type DecodeResult<T> =
  | { status: "legacy"; data: T; needsMigration: true }
  | { status: "v1"; data: T; needsMigration: false }
  | { status: "invalid"; reason: "invalid-shape" }
  | { status: "unsupported-version"; version: number };

export type NormalizationResult = {
  data: TrainerCrmData;
  removedExerciseTrainingIds: number[];
  danglingClientTrainingIds: number[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

function isArrayOf<T>(value: unknown, guard: Guard<T>): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

export function isClient(value: unknown): value is Client {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    typeof value.name === "string" &&
    isFiniteNumber(value.weight) &&
    isFiniteNumber(value.startWeight)
  );
}

export function isTraining(value: unknown): value is Training {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    isInteger(value.clientId) &&
    typeof value.clientName === "string" &&
    typeof value.date === "string" &&
    typeof value.time === "string" &&
    typeof value.type === "string" &&
    typeof value.completed === "boolean"
  );
}

export function isExerciseSet(value: unknown): value is ExerciseSet {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    isFiniteNumber(value.weight) &&
    isFiniteNumber(value.reps)
  );
}

export function isExercise(value: unknown): value is Exercise {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    typeof value.name === "string" &&
    isArrayOf(value.sets, isExerciseSet)
  );
}

export function isClients(value: unknown): value is Client[] {
  return isArrayOf(value, isClient);
}

export function isTrainings(value: unknown): value is Training[] {
  return isArrayOf(value, isTraining);
}

export function isTrainingExercises(value: unknown): value is TrainingExercises {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, exercises]) => /^(0|[1-9]\d*)$/.test(key) && isArrayOf(exercises, isExercise),
    )
  );
}

export function isTrainerCrmData(value: unknown): value is TrainerCrmData {
  return (
    isRecord(value) &&
    isClients(value.clients) &&
    isTrainings(value.trainings) &&
    isTrainingExercises(value.exercises)
  );
}

export function decodeSlice<T>(value: unknown, guard: Guard<T>): DecodeResult<T> {
  if (isRecord(value) && "schemaVersion" in value) {
    if (typeof value.schemaVersion === "number" && value.schemaVersion !== TRAINER_CRM_SCHEMA_VERSION) {
      return { status: "unsupported-version", version: value.schemaVersion };
    }

    if (
      value.schemaVersion === TRAINER_CRM_SCHEMA_VERSION &&
      "data" in value &&
      guard(value.data)
    ) {
      return { status: "v1", data: value.data, needsMigration: false };
    }

    return { status: "invalid", reason: "invalid-shape" };
  }

  return guard(value)
    ? { status: "legacy", data: value, needsMigration: true }
    : { status: "invalid", reason: "invalid-shape" };
}

export function serializeSlice<T>(data: T, guard: Guard<T>): string {
  if (!guard(data)) {
    throw new TypeError("Cannot serialize an invalid TrainerCRM slice");
  }

  const snapshot: TrainerCrmSnapshotV1<T> = {
    schemaVersion: TRAINER_CRM_SCHEMA_VERSION,
    data,
  };
  return JSON.stringify(snapshot);
}

export function normalizeOwnedReferences(data: TrainerCrmData): NormalizationResult {
  const trainingIds = new Set(data.trainings.map(({ id }) => id));
  const clientIds = new Set(data.clients.map(({ id }) => id));
  const exercises: TrainingExercises = {};
  const removedExerciseTrainingIds: number[] = [];

  for (const [rawTrainingId, ownedExercises] of Object.entries(data.exercises)) {
    const trainingId = Number(rawTrainingId);
    if (trainingIds.has(trainingId)) {
      exercises[trainingId] = ownedExercises;
    } else {
      removedExerciseTrainingIds.push(trainingId);
    }
  }

  return {
    data: { ...data, exercises },
    removedExerciseTrainingIds,
    danglingClientTrainingIds: data.trainings
      .filter(({ clientId }) => !clientIds.has(clientId))
      .map(({ id }) => id),
  };
}
