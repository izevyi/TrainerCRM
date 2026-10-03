export const TRAINER_CRM_SCHEMA_VERSION = 1 as const;

export type Client = {
  id: number;
  name: string;
  weight: number;
  startWeight: number;
};

export type Training = {
  id: number;
  clientId: number;
  clientName: string;
  date: string;
  time: string;
  type: string;
  completed: boolean;
};

export type ExerciseSet = {
  id: number;
  weight: number;
  reps: number;
};

export type Exercise = {
  id: number;
  name: string;
  sets: ExerciseSet[];
};

export type TrainingExercises = Record<number, Exercise[]>;

export type TrainerCrmData = {
  clients: Client[];
  trainings: Training[];
  exercises: TrainingExercises;
};

export type TrainerCrmSnapshotV1<T> = {
  schemaVersion: typeof TRAINER_CRM_SCHEMA_VERSION;
  data: T;
};
