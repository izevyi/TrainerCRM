export const monthNames = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
] as const;

export const weekDays = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"] as const;

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export type LocalDateTimeResult =
  | { ok: true; value: Date }
  | { ok: false; reason: "invalid" | "nonexistent" | "ambiguous" };

export type LocalDateTimeFields = { date: string; time: string };

function localParts(value: Date) {
  return [value.getFullYear(), value.getMonth() + 1, value.getDate(), value.getHours(), value.getMinutes()] as const;
}

function parsedFields(date: string, time: string): readonly [number, number, number, number, number] | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]); const month = Number(dateMatch[2]); const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]); const minute = Number(timeMatch[2]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthDays[month - 1] ? [year, month, day, hour, minute] : null;
}

export function localDateTimeFields(value: string | Date): LocalDateTimeFields {
  const date = typeof value === "string" ? new Date(value) : value;
  return {
    date: localDateKey(date),
    time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}

/** Resolves a browser-local wall time without accepting Date's gap normalization or fold preference. */
export function resolveLocalDateTime(date: string, time: string): LocalDateTimeResult {
  const parts = parsedFields(date, time);
  if (!parts) return { ok: false, reason: "invalid" };
  const [year, month, day, hour, minute] = parts;
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta += 1) offsets.add(new Date(wallAsUtc + delta * 3_600_000).getTimezoneOffset());
  const candidates = [...offsets]
    .map((offset) => new Date(wallAsUtc + offset * 60_000))
    .filter((candidate) => localParts(candidate).every((part, index) => part === parts[index]));
  const unique = [...new Map(candidates.map((candidate) => [candidate.getTime(), candidate])).values()];
  if (unique.length === 0) return { ok: false, reason: "nonexistent" };
  if (unique.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, value: unique[0] };
}

export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const end = new Date(last);
  end.setDate(end.getDate() + (7 - ((end.getDay() + 6) % 7) - 1));
  const days: Date[] = [];
  for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) days.push(new Date(day));
  return days;
}

export type AppointmentRange = { from: string; to: string };

export function appointmentRanges(days: readonly Date[]): AppointmentRange[] {
  if (days.length === 0) return [];
  const start = new Date(days[0].getFullYear(), days[0].getMonth(), days[0].getDate());
  const end = new Date(days.at(-1)!.getFullYear(), days.at(-1)!.getMonth(), days.at(-1)!.getDate() + 1);
  const maxMs = 31 * 24 * 60 * 60 * 1_000;
  const ranges: AppointmentRange[] = [];
  for (let cursor = start.getTime(); cursor < end.getTime();) {
    const next = Math.min(cursor + maxMs, end.getTime());
    ranges.push({ from: new Date(cursor).toISOString(), to: new Date(next).toISOString() });
    cursor = next;
  }
  return ranges;
}

export function localDateTime(date: Date, time: string): Date | null {
  const result = resolveLocalDateTime(localDateKey(date), time);
  return result.ok ? result.value : null;
}
