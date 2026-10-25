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
  setCount: number;
  repCount: number;
  volumeKg: number;
  hasUnrecordedLoad: boolean;
};

export type StrengthChange = {
  firstWeight: number;
  latestWeight: number;
  deltaKg: number;
  deltaPct: number;
};

export type ExerciseProgress = {
  key: string;
  name: string;
  occurrences: ExerciseOccurrence[];
  weightedOccurrences: ExerciseOccurrence[];
  strengthChange: StrengthChange | null;
};

export type ClientProgress = {
  completedThisMonth: number;
  completedTotal: number;
  latestCompleted: CompletedTrainingSummary | null;
  volumeThisMonthKg?: number;
  volumeTotalKg?: number;
  hasUnrecordedLoadThisMonth?: boolean;
  hasUnrecordedLoadTotal?: boolean;
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

function isPerformedSet(set: ExerciseSet): boolean {
  return Number.isFinite(set.reps) && set.reps > 0;
}

function isPositiveWeight(weight: number): boolean {
  return Number.isFinite(weight) && weight > 0;
}

function addFinite(total: number, contribution: number): number {
  const next = total + contribution;
  return Number.isFinite(next) ? next : total;
}

function occurrenceMetrics(sets: readonly ExerciseSet[]) {
  const weightedSets = sets.filter((set) => isPositiveWeight(set.weight));
  const sumFinite = (values: readonly number[]): number =>
    values.reduce(addFinite, 0);

  return {
    workingWeight:
      weightedSets.length > 0
        ? Math.max(...weightedSets.map((set) => set.weight))
        : null,
    setCount: sets.length,
    repCount: sumFinite(sets.map((set) => set.reps)),
    volumeKg: sumFinite(
      weightedSets
        .map((set) => set.weight * set.reps)
        .filter(Number.isFinite),
    ),
    hasUnrecordedLoad: weightedSets.length < sets.length,
  };
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
  let volumeThisMonthKg = 0;
  let volumeTotalKg = 0;
  let hasUnrecordedLoadThisMonth = false;
  let hasUnrecordedLoadTotal = false;

  for (const training of completed) {
    for (const exercise of exercisesByTraining[training.id] ?? []) {
      const performedSets = exercise.sets
        .filter(isPerformedSet)
        .map(cloneSet);
      const key = normalizeExerciseName(exercise.name);

      if (performedSets.length === 0 || key.length === 0) continue;

      const metrics = occurrenceMetrics(performedSets);
      volumeTotalKg = addFinite(volumeTotalKg, metrics.volumeKg);
      hasUnrecordedLoadTotal ||= metrics.hasUnrecordedLoad;
      if (training.date.startsWith(`${monthKey}-`)) {
        volumeThisMonthKg = addFinite(volumeThisMonthKg, metrics.volumeKg);
        hasUnrecordedLoadThisMonth ||= metrics.hasUnrecordedLoad;
      }

      const occurrence: ExerciseOccurrence = {
        trainingId: training.id,
        date: training.date,
        time: training.time,
        trainingType: training.type,
        sets: performedSets,
        ...metrics,
      };
      const current = grouped.get(key);

      if (current) {
        current.name = exercise.name.trim().replace(/\s+/g, " ");
        const latestOccurrence = current.occurrences.at(-1);
        if (latestOccurrence?.trainingId === training.id) {
          latestOccurrence.sets.push(...performedSets);
          Object.assign(
            latestOccurrence,
            occurrenceMetrics(latestOccurrence.sets),
          );
        } else {
          current.occurrences.push(occurrence);
        }
      } else {
        grouped.set(key, {
          name: exercise.name.trim().replace(/\s+/g, " "),
          occurrences: [occurrence],
        });
      }
    }
  }

  const exerciseProgress = Array.from(grouped, ([key, value]) => {
    const weightedOccurrences = value.occurrences.filter(
      (occurrence) => occurrence.workingWeight !== null,
    );
    const firstWeighted = weightedOccurrences[0];
    const latestWeighted = weightedOccurrences.at(-1);
    const strengthChange =
      firstWeighted && latestWeighted && weightedOccurrences.length >= 2
        ? {
            firstWeight: firstWeighted.workingWeight!,
            latestWeight: latestWeighted.workingWeight!,
            deltaKg:
              latestWeighted.workingWeight! - firstWeighted.workingWeight!,
            deltaPct:
              ((latestWeighted.workingWeight! - firstWeighted.workingWeight!) /
                firstWeighted.workingWeight!) *
              100,
          }
        : null;

    return {
      key,
      name: value.name,
      occurrences: value.occurrences,
      weightedOccurrences,
      strengthChange,
    };
  }).sort((a, b) => {
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
    volumeThisMonthKg,
    volumeTotalKg,
    hasUnrecordedLoadThisMonth,
    hasUnrecordedLoadTotal,
    exercises: exerciseProgress,
  };
}
