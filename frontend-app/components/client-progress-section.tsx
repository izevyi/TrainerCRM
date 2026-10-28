"use client";

import { useState } from "react";

import type { ClientProgress } from "../lib/progress/client-progress";
import {
  buildChartPoints,
  selectTickIndices,
  summarizeTrend,
} from "../lib/progress/chart-presentation";

type ClientProgressSectionProps = {
  progress: ClientProgress;
};

function formatDisplayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function formatKg(value: number): string {
  return `${value.toFixed(1)} кг`;
}

function formatSigned(value: number, suffix: string): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} ${suffix}`;
}

function formatVolume(value: number, hasUnrecordedLoad: boolean): string {
  if (value === 0 && hasUnrecordedLoad) return "—";
  return formatKg(value);
}

function formatCalories(value: number | null): string {
  return value === null ? "Нет данных" : `${value.toLocaleString("ru-RU")} ккал`;
}

function WorkingWeightChart({
  exerciseName,
  observations,
}: {
  exerciseName: string;
  observations: ClientProgress["exercises"][number]["weightedOccurrences"];
}) {
  const chartObservations = observations.map((observation) => ({
    date: observation.date,
    value: observation.workingWeight!,
  }));
  const points = buildChartPoints(chartObservations);
  const summary = summarizeTrend(chartObservations);
  const mobileTicks = selectTickIndices(observations.length, 3);
  const desktopTicks = selectTickIndices(observations.length, 5);
  const direction =
    summary.direction === "increase"
      ? "увеличился"
      : summary.direction === "decrease"
        ? "уменьшился"
        : "не изменился";

  return (
    <figure className="mt-4 rounded-2xl bg-zinc-50 p-3">
      <figcaption className="text-sm text-zinc-600">
        {summary.count === 1 ? (
          <>
            Одна запись: {formatDisplayDate(summary.first!.date)} · {formatKg(summary.first!.value)}. Для тренда нужна ещё одна запись.
          </>
        ) : (
          <>
            Наблюдений: {summary.count}. Период с {formatDisplayDate(summary.first!.date)} по {formatDisplayDate(summary.latest!.date)}. Рабочий вес {direction}: {formatKg(summary.first!.value)} → {formatKg(summary.latest!.value)} ({formatSigned(summary.delta!, "кг")}).
          </>
        )}
      </figcaption>
      <div className="mt-3 h-40 sm:h-52">
        <svg
          viewBox="0 0 640 180"
          className="h-full w-full"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <line
            x1="20"
            y1="90"
            x2="620"
            y2="90"
            stroke="currentColor"
            className="text-zinc-200"
            vectorEffect="non-scaling-stroke"
            aria-hidden="true"
          />
          {points.length > 1 && (
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-zinc-900"
              points={points.map(({ x, y }) => `${x},${y}`).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {points.map(({ index, x, y }) => (
            <circle
              key={`${observations[index].trainingId}-${observations[index].date}-${index}`}
              cx={x}
              cy={y}
              r="6"
              fill="currentColor"
              className="text-zinc-900"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>
      <div className="mt-2 flex justify-between gap-2 text-[10px] text-zinc-500 sm:hidden" aria-hidden="true">
        {mobileTicks.map((index) => (
          <span key={index} className="min-w-0 text-center first:text-left last:text-right">
            {formatDisplayDate(observations[index].date)}
          </span>
        ))}
      </div>
      <div className="mt-2 hidden justify-between gap-2 text-[10px] text-zinc-500 sm:flex" aria-hidden="true">
        {desktopTicks.map((index) => (
          <span key={index} className="min-w-0 text-center first:text-left last:text-right">
            {formatDisplayDate(observations[index].date)}
          </span>
        ))}
      </div>
      <span className="sr-only">Упражнение: {exerciseName}.</span>
    </figure>
  );
}

export function ClientProgressSection({ progress }: ClientProgressSectionProps) {
  const [selectedKey, setSelectedKey] = useState(
    progress.exercises[0]?.key ?? "",
  );
  const [expandedExerciseKey, setExpandedExerciseKey] = useState<string | null>(
    null,
  );
  const selectedExercise =
    progress.exercises.find((exercise) => exercise.key === selectedKey) ??
    progress.exercises[0];
  const latestOccurrence = selectedExercise?.occurrences.at(-1);
  const isHistoryExpanded = expandedExerciseKey === selectedExercise?.key;
  const visibleOccurrences = selectedExercise
    ? isHistoryExpanded
      ? selectedExercise.occurrences
      : selectedExercise.occurrences.slice(-3)
    : [];

  return (
    <section
      className="mt-5 rounded-2xl border border-zinc-200 bg-white p-4"
      aria-labelledby="client-progress-heading"
    >
      <p className="text-xs text-zinc-500">Выполненные тренировки</p>
      <h3 id="client-progress-heading" className="mt-1 font-semibold">
        Прогресс по упражнениям
      </h3>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="min-w-0 rounded-xl bg-zinc-50 p-3">
          <p className="text-xs text-zinc-500">Калории · за месяц</p>
          <p className="mt-1 break-words text-sm font-semibold tabular-nums">
            {formatCalories(progress.caloriesThisMonth)}
          </p>
        </div>
        <div className="min-w-0 rounded-xl bg-zinc-50 p-3">
          <p className="text-xs text-zinc-500">Калории · всё время</p>
          <p className="mt-1 break-words text-sm font-semibold tabular-nums">
            {formatCalories(progress.caloriesTotal)}
          </p>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="min-w-0 rounded-xl bg-zinc-50 p-3">
          <p className="text-xs text-zinc-500">Внешний вес · за месяц</p>
          <p className="mt-1 break-words text-sm font-semibold tabular-nums">
            {formatVolume(
              progress.volumeThisMonthKg ?? 0,
              progress.hasUnrecordedLoadThisMonth ?? false,
            )}
          </p>
        </div>
        <div className="min-w-0 rounded-xl bg-zinc-50 p-3">
          <p className="text-xs text-zinc-500">Внешний вес · всё время</p>
          <p className="mt-1 break-words text-sm font-semibold tabular-nums">
            {formatVolume(
              progress.volumeTotalKg ?? 0,
              progress.hasUnrecordedLoadTotal ?? false,
            )}
          </p>
        </div>
      </div>
      {(progress.hasUnrecordedLoadThisMonth ||
        progress.hasUnrecordedLoadTotal) && (
        <p className="mt-2 text-xs text-zinc-500">
          Объём учитывает только подходы с записанным внешним весом. Подходы без него сохранены в повторениях.
        </p>
      )}

      {!selectedExercise ? (
        <p className="mt-4 text-sm text-zinc-500">
          Пока нет выполненных упражнений с указанными повторами.
        </p>
      ) : (
        <>
          <label
            htmlFor="client-progress-exercise"
            className="mt-4 block text-xs font-medium text-zinc-600"
          >
            Упражнение
          </label>
          <select
            id="client-progress-exercise"
            value={selectedExercise.key}
            onChange={(event) => {
              setSelectedKey(event.target.value);
              setExpandedExerciseKey(null);
            }}
            className="mt-2 min-h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-violet-500 sm:text-sm"
          >
            {progress.exercises.map((exercise) => (
              <option key={exercise.key} value={exercise.key}>
                {exercise.name}
              </option>
            ))}
          </select>

          <div className="mt-4 grid grid-cols-1 gap-2 min-[390px]:grid-cols-2 sm:grid-cols-4">
            <div className="min-w-0 rounded-xl border border-zinc-100 p-3">
              <p className="text-xs text-zinc-500">Последний рабочий вес</p>
              <p className="mt-1 break-words text-sm font-semibold tabular-nums">
                {latestOccurrence?.workingWeight == null
                  ? "—"
                  : formatKg(latestOccurrence.workingWeight)}
              </p>
            </div>
            <div className="min-w-0 rounded-xl border border-zinc-100 p-3">
              <p className="text-xs text-zinc-500">Изменение</p>
              <p className="mt-1 break-words text-sm font-semibold tabular-nums">
                {selectedExercise.strengthChange
                  ? `${formatSigned(selectedExercise.strengthChange.deltaKg, "кг")} · ${formatSigned(selectedExercise.strengthChange.deltaPct, "%")}`
                  : "—"}
              </p>
              {!selectedExercise.strengthChange && (
                <p className="mt-1 text-[10px] text-zinc-400">
                  Нужно два выполнения с весом
                </p>
              )}
            </div>
            <div className="min-w-0 rounded-xl border border-zinc-100 p-3">
              <p className="text-xs text-zinc-500">Последнее выполнение</p>
              <p className="mt-1 break-words text-sm font-semibold tabular-nums">
                {latestOccurrence?.setCount} подх. · {latestOccurrence?.repCount} повт.
              </p>
            </div>
            <div className="min-w-0 rounded-xl border border-zinc-100 p-3">
              <p className="text-xs text-zinc-500">Объём с внешним весом</p>
              <p className="mt-1 break-words text-sm font-semibold tabular-nums">
                {latestOccurrence
                  ? formatVolume(
                      latestOccurrence.volumeKg,
                      latestOccurrence.hasUnrecordedLoad,
                    )
                  : "—"}
              </p>
              {latestOccurrence?.hasUnrecordedLoad &&
                latestOccurrence.volumeKg > 0 && (
                  <p className="mt-1 text-[10px] text-zinc-400">
                    Только записанный вес
                  </p>
                )}
            </div>
          </div>

          {selectedExercise.weightedOccurrences.length > 0 ? (
            <WorkingWeightChart
              exerciseName={selectedExercise.name}
              observations={selectedExercise.weightedOccurrences}
            />
          ) : (
            <div className="mt-4 rounded-xl bg-zinc-50 p-3 text-sm text-zinc-500">
              Выполнения сохранены без положительного веса. История повторов доступна ниже, график в килограммах не строится.
            </div>
          )}

          <div className="mt-4">
            <h4 className="text-sm font-semibold">История выполнений</h4>
            <ul id="exercise-history" className="mt-2 space-y-2">
              {visibleOccurrences.map((occurrence, occurrenceIndex) => (
                <li
                  key={`${occurrence.trainingId}-${occurrenceIndex}`}
                  className="rounded-xl border border-zinc-100 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-medium">
                      {formatDisplayDate(occurrence.date)} · {occurrence.time}
                    </span>
                    <span className="text-zinc-500">
                      {occurrence.workingWeight === null
                        ? "Внешний вес не указан"
                        : `Рабочий вес ${formatKg(occurrence.workingWeight)}`}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {occurrence.setCount} подх. · {occurrence.repCount} повт. · объём с внешним весом {formatVolume(occurrence.volumeKg, occurrence.hasUnrecordedLoad)}
                    {occurrence.hasUnrecordedLoad && occurrence.volumeKg > 0
                      ? " (только записанный вес)"
                      : ""}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {occurrence.sets
                      .map(
                        (set, index) =>
                          `${index + 1}: ${Number.isFinite(set.weight) && set.weight > 0 ? `${set.weight.toFixed(1)} кг × ` : ""}${set.reps} повт.`,
                      )
                      .join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
            {selectedExercise.occurrences.length > 3 && (
              <button
                type="button"
                aria-expanded={isHistoryExpanded}
                aria-controls="exercise-history"
                onClick={() =>
                  setExpandedExerciseKey(
                    isHistoryExpanded ? null : selectedExercise.key,
                  )
                }
                className="mt-2 min-h-11 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm font-medium outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
              >
                {isHistoryExpanded
                  ? "Свернуть историю"
                  : `Показать все (${selectedExercise.occurrences.length})`}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
