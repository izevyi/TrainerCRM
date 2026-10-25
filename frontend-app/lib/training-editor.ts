import type {
  Training,
  TrainingExercises,
} from "./domain/trainer-crm";

export type NumericExerciseField = "weight" | "reps";

export type ExerciseRenameResult = {
  exercises: TrainingExercises;
  status: "updated" | "empty" | "not-found";
  duplicateName: boolean;
};

export type ExerciseSetUpdateResult = {
  exercises: TrainingExercises;
  status: "updated" | "invalid" | "not-found";
};

export function normalizeExerciseNameForCommit(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function normalizedExerciseKey(name: string): string {
  return normalizeExerciseNameForCommit(name).toLocaleLowerCase();
}

export function renameExercise(
  exercises: TrainingExercises,
  trainingId: number,
  exerciseId: number,
  draftName: string,
): ExerciseRenameResult {
  const name = normalizeExerciseNameForCommit(draftName);
  if (name.length === 0) {
    return { exercises, status: "empty", duplicateName: false };
  }

  const ownedExercises = exercises[trainingId];
  if (!ownedExercises?.some((exercise) => exercise.id === exerciseId)) {
    return { exercises, status: "not-found", duplicateName: false };
  }

  const duplicateName = ownedExercises.some(
    (exercise) =>
      exercise.id !== exerciseId &&
      normalizedExerciseKey(exercise.name) === normalizedExerciseKey(name),
  );

  return {
    exercises: {
      ...exercises,
      [trainingId]: ownedExercises.map((exercise) =>
        exercise.id === exerciseId ? { ...exercise, name } : exercise,
      ),
    },
    status: "updated",
    duplicateName,
  };
}

export function parseExerciseNumber(
  field: NumericExerciseField,
  draftValue: string,
): number | null {
  if (draftValue.trim().length === 0) return null;

  const value = Number(draftValue);
  if (!Number.isFinite(value) || value < 0) return null;
  if (field === "weight" && !Number.isInteger(value * 2)) return null;
  if (field === "reps" && !Number.isInteger(value)) return null;

  return value;
}

export function updateExerciseSetValue(
  exercises: TrainingExercises,
  trainingId: number,
  exerciseId: number,
  setId: number,
  field: NumericExerciseField,
  draftValue: string,
): ExerciseSetUpdateResult {
  const value = parseExerciseNumber(field, draftValue);
  if (value === null) return { exercises, status: "invalid" };

  const ownedExercises = exercises[trainingId];
  const targetExists = ownedExercises?.some(
    (exercise) =>
      exercise.id === exerciseId &&
      exercise.sets.some((set) => set.id === setId),
  );
  if (!ownedExercises || !targetExists) {
    return { exercises, status: "not-found" };
  }

  return {
    exercises: {
      ...exercises,
      [trainingId]: ownedExercises.map((exercise) =>
        exercise.id === exerciseId
          ? {
              ...exercise,
              sets: exercise.sets.map((set) =>
                set.id === setId ? { ...set, [field]: value } : set,
              ),
            }
          : exercise,
      ),
    },
    status: "updated",
  };
}

export function deleteOwnedTraining(
  trainings: readonly Training[],
  exercises: TrainingExercises,
  trainingId: number,
): { trainings: Training[]; exercises: TrainingExercises } {
  const remainingExercises = Object.fromEntries(
    Object.entries(exercises).filter(
      ([rawTrainingId]) => Number(rawTrainingId) !== trainingId,
    ),
  );

  return {
    trainings: trainings.filter((training) => training.id !== trainingId),
    exercises: remainingExercises,
  };
}
