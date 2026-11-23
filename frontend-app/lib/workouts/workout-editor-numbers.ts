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

/** Change a valid workout number by one editor step, without rounding invalid input. */
export function stepWorkoutNumber(field: WorkoutNumberField, draft: string, direction: -1 | 1): string | null {
  const value = parseWorkoutNumber(field, draft);
  if (value === null) return null;
  // Work in integer units to avoid floating-point rounding drift.
  const scaled = field === "weight" ? value * 2 : value;
  const maximum = field === "weight" ? 2000 : 10000;
  const next = scaled + direction;
  if (next < 0 || next > maximum) return null;
  return field === "weight" ? formatWorkoutWeight(next / 2) : String(next);
}
