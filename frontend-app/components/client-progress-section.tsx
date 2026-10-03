"use client";

import { useState } from "react";

import type { ClientProgress } from "../lib/progress/client-progress";

type ClientProgressSectionProps = {
  progress: ClientProgress;
};

function formatDisplayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function WorkingWeightChart({
  exerciseName,
  observations,
}: {
  exerciseName: string;
  observations: ClientProgress["exercises"][number]["weightedOccurrences"];
}) {
  const weights = observations.map((observation) => observation.workingWeight!);
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const range = Math.max(max - min, 1);
  const points = observations.map((observation, index) => ({
    key: `${observation.trainingId}-${observation.date}-${observation.time}-${index}`,
    x: observations.length === 1 ? 320 : 20 + (index / (observations.length - 1)) * 600,
    y: 150 - ((observation.workingWeight! - min) / range) * 110,
  }));

  return (
    <div className="mt-4 rounded-2xl bg-zinc-50 p-3">
      <div className="h-40">
        <svg
          viewBox="0 0 640 180"
          className="h-full w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Динамика рабочего веса упражнения «${exerciseName}»`}
        >
          <line
            x1="20"
            y1="150"
            x2="620"
            y2="150"
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
          {points.map(({ key, x, y }) => (
            <circle
              key={key}
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
      <div className="mt-2 flex justify-between gap-2 text-[10px] text-zinc-400">
        {observations.map((observation, index) => (
          <span key={`${observation.trainingId}-${index}`}>
            {formatDisplayDate(observation.date)} · {observation.workingWeight} кг
          </span>
        ))}
      </div>
      {observations.length === 1 && (
        <p className="mt-3 text-xs text-zinc-500">
          Нужно ещё одно выполнение с указанным весом для тренда.
        </p>
      )}
    </div>
  );
}

export function ClientProgressSection({ progress }: ClientProgressSectionProps) {
  const [selectedKey, setSelectedKey] = useState(
    progress.exercises[0]?.key ?? "",
  );
  const selectedExercise =
    progress.exercises.find((exercise) => exercise.key === selectedKey) ??
    progress.exercises[0];

  return (
    <section
      className="mt-5 rounded-2xl border border-zinc-200 p-4"
      aria-labelledby="client-progress-heading"
    >
      <p className="text-xs text-zinc-500">Выполненные тренировки</p>
      <h3 id="client-progress-heading" className="mt-1 font-semibold">
        Прогресс по упражнениям
      </h3>

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
            onChange={(event) => setSelectedKey(event.target.value)}
            className="mt-2 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-zinc-400"
          >
            {progress.exercises.map((exercise) => (
              <option key={exercise.key} value={exercise.key}>
                {exercise.name}
              </option>
            ))}
          </select>

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
            <ul className="mt-2 space-y-2">
              {selectedExercise.occurrences.map((occurrence, occurrenceIndex) => (
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
                        ? "Собственный вес / вес не указан"
                        : `Рабочий вес ${occurrence.workingWeight} кг`}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {occurrence.sets
                      .map(
                        (set, index) =>
                          `${index + 1}: ${set.weight > 0 ? `${set.weight} кг × ` : ""}${set.reps} повт.`,
                      )
                      .join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
