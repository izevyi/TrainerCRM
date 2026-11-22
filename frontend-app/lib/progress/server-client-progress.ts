import type { Workout } from "../workouts/workout-api";
import type { Training, TrainingExercises } from "../domain/trainer-crm";
import { buildClientProgress } from "./client-progress";

// The legacy chart engine expects numeric IDs. These transient indices exist
// only for chart calculation; server UUIDs remain authoritative everywhere.
export function buildServerClientProgress(workouts: readonly Workout[], referenceDate: Date = new Date()) {
  const trainings: Training[] = workouts.map((item, index) => ({
    id: index + 1,
    clientId: 1,
    clientName: item.clientName,
    date: item.date,
    time: item.time,
    type: item.type,
    completed: item.completed,
    ...(item.caloriesBurned === null ? {} : { caloriesBurned: item.caloriesBurned }),
  }));
  const exercises: TrainingExercises = {};
  workouts.forEach((workout, index) => {
    exercises[index + 1] = workout.exercises.map((exercise, exerciseIndex) => ({
      id: exerciseIndex + 1,
      name: exercise.name,
      sets: exercise.sets.map((set, setIndex) => ({ id: setIndex + 1, weight: set.weight, reps: set.reps })),
    }));
  });
  return buildClientProgress(1, trainings, exercises, referenceDate);
}
