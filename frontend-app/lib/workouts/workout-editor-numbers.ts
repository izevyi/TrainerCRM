export type WorkoutNumberField = "weight" | "reps";

const DECIMAL_NUMBER = /^\d+(?:[.,]\d+)?$/;
const INTEGER = /^\d+$/;

export function formatWorkoutWeight(value: number): string {
  return String(value).replace(".", ",");
}

export function parseWorkoutNumber(field: WorkoutNumberField, draft: string): number | null {
  const text = draft.trim();
  if (field === "reps") {
    if (!INTEGER.test(text)) return null;
  } else if (!DECIMAL_NUMBER.test(text)) {
    return null;
  }

  const value = Number(text.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  if (field === "weight") {
    return value <= 1000 && Number.isInteger(value * 2) ? value : null;
  }
  return value <= 10000 && Number.isInteger(value) ? value : null;
}

export function workoutNumberError(field: WorkoutNumberField): string {
  return field === "weight"
    ? "Введите вес целыми или половинами килограмма, например 50 или 50,5."
    : "Введите целое количество повторений.";
}
