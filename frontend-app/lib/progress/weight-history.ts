import type { Client, WeightMeasurement } from "../domain/trainer-crm";
import type { ChartObservation } from "./chart-presentation";

export type WeightMeasurementInput = {
  date: string;
  weight: number;
};

export type WeightHistoryResult =
  | { ok: true; client: Client; measurement: WeightMeasurement }
  | { ok: false; field: "date" | "weight"; message: string };

export function isValidMeasurementDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidMeasurementWeight(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function sortWeightMeasurements(
  measurements: readonly WeightMeasurement[] = [],
): WeightMeasurement[] {
  return measurements.slice().sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
}

export function deriveCurrentWeight(client: Client): number {
  return sortWeightMeasurements(client.weightMeasurements).at(-1)?.weight ?? client.weight;
}

export function deriveWeightGraphData(client: Client): ChartObservation[] {
  return sortWeightMeasurements(client.weightMeasurements).map(({ date, weight }) => ({
    date,
    value: weight,
  }));
}

function validateInput(
  measurements: readonly WeightMeasurement[],
  input: WeightMeasurementInput,
  editedId?: string,
): Exclude<WeightHistoryResult, { ok: true }> | null {
  if (!isValidMeasurementDate(input.date)) {
    return { ok: false, field: "date", message: "Введите существующую дату в формате ГГГГ-ММ-ДД." };
  }
  if (!isValidMeasurementWeight(input.weight)) {
    return { ok: false, field: "weight", message: "Введите положительный вес числом." };
  }
  if (measurements.some(({ id, date }) => id !== editedId && date === input.date)) {
    return { ok: false, field: "date", message: "На эту дату измерение уже добавлено." };
  }
  return null;
}

function nextMeasurementId(client: Client): {
  id: string;
  nextSequence: number;
} {
  const prefix = `wm-${client.id}-`;
  const used = new Set((client.weightMeasurements ?? []).map(({ id }) => id));
  let sequence = client.nextWeightMeasurementSequence ?? 1;

  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("Некорректный счётчик измерений.");
  }

  while (used.has(`${prefix}${sequence}`)) {
    sequence += 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new RangeError("Закончились идентификаторы измерений.");
    }
  }

  if (!Number.isSafeInteger(sequence + 1)) {
    throw new RangeError("Закончились идентификаторы измерений.");
  }

  return { id: `${prefix}${sequence}`, nextSequence: sequence + 1 };
}

function withMeasurements(client: Client, measurements: WeightMeasurement[]): Client {
  const ordered = sortWeightMeasurements(measurements);
  return {
    ...client,
    weight: ordered.at(-1)?.weight ??
      client.weightBeforeMeasurements ??
      client.weight,
    weightMeasurements: ordered,
  };
}

export function addWeightMeasurement(
  client: Client,
  input: WeightMeasurementInput,
): WeightHistoryResult {
  const measurements = client.weightMeasurements ?? [];
  const error = validateInput(measurements, input);
  if (error) return error;
  const { id, nextSequence } = nextMeasurementId(client);
  const measurement = { id, ...input };
  const updatedClient: Client = {
    ...client,
    weightBeforeMeasurements:
      client.weightBeforeMeasurements ??
      (measurements.length === 0 ? client.weight : undefined),
    nextWeightMeasurementSequence: nextSequence,
  };
  return {
    ok: true,
    measurement,
    client: withMeasurements(updatedClient, [...measurements, measurement]),
  };
}

export function editWeightMeasurement(
  client: Client,
  measurementId: string,
  input: WeightMeasurementInput,
): WeightHistoryResult {
  const measurements = client.weightMeasurements ?? [];
  const existing = measurements.find(({ id }) => id === measurementId);
  if (!existing) {
    return { ok: false, field: "date", message: "Измерение не найдено." };
  }
  const error = validateInput(measurements, input, measurementId);
  if (error) return error;
  const measurement = { ...existing, ...input };
  return {
    ok: true,
    measurement,
    client: withMeasurements(
      client,
      measurements.map((item) => item.id === measurementId ? measurement : item),
    ),
  };
}

export function deleteWeightMeasurement(client: Client, measurementId: string): Client {
  const measurements = client.weightMeasurements ?? [];
  const remaining = measurements.filter(({ id }) => id !== measurementId);
  if (remaining.length === measurements.length) return client;
  const ordered = sortWeightMeasurements(remaining);
  return {
    ...client,
    weight: ordered.at(-1)?.weight ??
      client.weightBeforeMeasurements ??
      client.weight,
    weightMeasurements: ordered,
  };
}
