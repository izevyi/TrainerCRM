import type {
  ExerciseSet,
  Training,
  TrainingExercises,
} from "../domain/trainer-crm";

export type CompletedTrainingSummary = Pick<
  Training,
  "id" | "date" | "time" | "type"
>;

export type ExerciseOccurrence = {
  trainingId: number;
  date: string;
  time: string;
  trainingType: string;
  sets: ExerciseSet[];
  workingWeight: number | null;
};

export type ExerciseProgress = {
  key: string;
  name: string;
  occurrences: ExerciseOccurrence[];
  weightedOccurrences: ExerciseOccurrence[];
};

export type ClientProgress = {
  completedThisMonth: number;
  completedTotal: number;
  latestCompleted: CompletedTrainingSummary | null;
  exercises: ExerciseProgress[];
};

export function normalizeExerciseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function compareTrainingOrder(a: Training, b: Training): number {
  return (
    a.date.localeCompare(b.date) ||
    a.time.localeCompare(b.time) ||
    a.id - b.id
  );
}

function cloneSet(set: ExerciseSet): ExerciseSet {
  return { ...set };
}

export function buildClientProgress(
  clientId: number,
  trainings: readonly Training[],
  exercisesByTraining: Readonly<TrainingExercises>,
  referenceDate: Date,
): ClientProgress {
  const monthKey = `${referenceDate.getFullYear()}-${String(
    referenceDate.getMonth() + 1,
  ).padStart(2, "0")}`;
  const completed = trainings
    .filter((training) => training.clientId === clientId && training.completed)
    .slice()
    .sort(compareTrainingOrder);
  const latest = completed.at(-1) ?? null;
  const grouped = new Map<
    string,
    { name: string; occurrences: ExerciseOccurrence[] }
  >();

  for (const training of completed) {
    for (const exercise of exercisesByTraining[training.id] ?? []) {
      const performedSets = exercise.sets
        .filter((set) => set.reps > 0)
        .map(cloneSet);
      const key = normalizeExerciseName(exercise.name);

      if (performedSets.length === 0 || key.length === 0) continue;

      const positiveWeights = performedSets
        .map((set) => set.weight)
        .filter((weight) => weight > 0);
      const occurrence: ExerciseOccurrence = {
        trainingId: training.id,
        date: training.date,
        time: training.time,
        trainingType: training.type,
        sets: performedSets,
        workingWeight:
          positiveWeights.length > 0 ? Math.max(...positiveWeights) : null,
      };
      const current = grouped.get(key);

      if (current) {
        current.name = exercise.name.trim().replace(/\s+/g, " ");
        current.occurrences.push(occurrence);
      } else {
        grouped.set(key, {
          name: exercise.name.trim().replace(/\s+/g, " "),
          occurrences: [occurrence],
        });
      }
    }
  }

  const exerciseProgress = Array.from(grouped, ([key, value]) => ({
    key,
    name: value.name,
    occurrences: value.occurrences,
    weightedOccurrences: value.occurrences.filter(
      (occurrence) => occurrence.workingWeight !== null,
    ),
  })).sort((a, b) => {
    const latestA = a.occurrences.at(-1)!;
    const latestB = b.occurrences.at(-1)!;
    return (
      latestB.date.localeCompare(latestA.date) ||
      latestB.time.localeCompare(latestA.time) ||
      latestB.trainingId - latestA.trainingId ||
      a.name.localeCompare(b.name)
    );
  });

  return {
    completedThisMonth: completed.filter((training) =>
      training.date.startsWith(`${monthKey}-`),
    ).length,
    completedTotal: completed.length,
    latestCompleted: latest
      ? {
          id: latest.id,
          date: latest.date,
          time: latest.time,
          type: latest.type,
        }
      : null,
    exercises: exerciseProgress,
  };
}
