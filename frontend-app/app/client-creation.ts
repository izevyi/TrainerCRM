import type { Client, TrainerCrmData } from "../lib/domain/trainer-crm";

export type ClientCreationInput = {
  name: string;
  startingWeight: string;
};

export type ClientCreationError = {
  ok: false;
  fieldErrors: {
    name?: string;
    startingWeight?: string;
  };
};

export type ClientCreationSuccess = {
  ok: true;
  client: Client;
  data: TrainerCrmData;
};

export type ClientCreationResult = ClientCreationError | ClientCreationSuccess;

function nextClientId(clients: readonly Client[]): number {
  const usedIds = new Set(
    clients
      .map(({ id }) => id)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  let highestId = 0;

  for (const id of usedIds) highestId = Math.max(highestId, id);

  if (highestId < Number.MAX_SAFE_INTEGER) return highestId + 1;

  for (let candidate = 1; candidate <= usedIds.size + 1; candidate += 1) {
    if (!usedIds.has(candidate)) return candidate;
  }

  throw new RangeError("Не удалось подобрать безопасный идентификатор клиента.");
}

export function createClient(
  currentData: TrainerCrmData,
  input: ClientCreationInput,
): ClientCreationResult {
  const name = input.name.trim();
  const weightText = input.startingWeight.trim();
  const startingWeight = Number(weightText);
  const fieldErrors: ClientCreationError["fieldErrors"] = {};

  if (name.length === 0) {
    fieldErrors.name = "Введите имя клиента.";
  } else if (name.length > 120) {
    fieldErrors.name = "Имя должно содержать не более 120 символов.";
  }

  if (
    weightText.length === 0 ||
    !Number.isFinite(startingWeight) ||
    startingWeight <= 0
  ) {
    fieldErrors.startingWeight = "Введите положительный вес числом.";
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const client: Client = {
    id: nextClientId(currentData.clients),
    name,
    weight: startingWeight,
    startWeight: startingWeight,
  };

  return {
    ok: true,
    client,
    data: {
      ...currentData,
      clients: [...currentData.clients, client],
    },
  };
}
