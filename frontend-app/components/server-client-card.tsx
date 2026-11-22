"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ServerClient } from "../lib/clients/client-api";
import { deleteWeight, listWeights, saveWeight, type ServerWeight } from "../lib/clients/weight-api";
import { isValidMeasurementDate } from "../lib/progress/weight-history";
import { buildChartPoints, summarizeTrend } from "../lib/progress/chart-presentation";
import { buildServerClientProgress } from "../lib/progress/server-client-progress";
import { listWorkouts, type Workout } from "../lib/workouts/workout-api";
import { ClientProgressSection } from "./client-progress-section";

type Tab = "overview" | "trainings" | "progress";
type Props = { client: ServerClient; onClose: () => void; onAuthenticationFailure: () => void };
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const shownDate = (value: string) => value.split("-").reverse().join(".");
const shownWeight = (weight: number) => `${weight.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} кг`;

export function ServerClientCard({ client, onClose, onAuthenticationFailure }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const authenticationFailureRef = useRef(onAuthenticationFailure);
  useEffect(() => { authenticationFailureRef.current = onAuthenticationFailure; }, [onAuthenticationFailure]);
  const [tab, setTab] = useState<Tab>("overview");
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [weights, setWeights] = useState<ServerWeight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(localDate);
  const [weight, setWeight] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = originalOverflow; document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void Promise.all([
      listWorkouts(client.id, fetch, controller.signal),
      listWeights(client.id, fetch, controller.signal),
    ]).then(([trainingResult, weightResult]) => {
      if (!active) return;
      if ((!trainingResult.ok && trainingResult.kind === "unauthorized") ||
          (!weightResult.ok && weightResult.kind === "unauthorized")) {
        authenticationFailureRef.current();
        return;
      }
      if (trainingResult.ok && weightResult.ok) {
        setWorkouts(trainingResult.value);
        setWeights(weightResult.value);
        setError(null);
      } else {
        setError("Не удалось загрузить карточку клиента. Проверьте соединение и попробуйте открыть её снова.");
      }
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [client.id]);

  const orderedWeights = useMemo(() => weights.slice().sort((a, b) => a.date.localeCompare(b.date)), [weights]);
  const observations = useMemo(() => orderedWeights.map(item => ({ date: item.date, value: item.weight })), [orderedWeights]);
  const points = useMemo(() => buildChartPoints(observations), [observations]);
  const trend = useMemo(() => summarizeTrend(observations), [observations]);
  const latestWeight = orderedWeights.at(-1)?.weight ?? client.startingWeight;
  const completed = workouts.filter(item => item.completed);
  const progress = useMemo(() => buildServerClientProgress(workouts), [workouts]);

  function resetForm() { setEditId(null); setDate(localDate()); setWeight(""); setFormError(null); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const parsed = Number(weight.trim().replace(",", "."));
    if (!isValidMeasurementDate(date) || !weight.trim() || !Number.isFinite(parsed) || parsed < 0.001 || parsed > 1000 || !Number.isInteger(parsed * 1000)) {
      setFormError("Укажи реальную дату и вес от 0,001 до 1000 кг (до трёх знаков после запятой).");
      return;
    }
    setBusy(true); setFormError(null);
    const result = await saveWeight(client.id, date, parsed, editId);
    setBusy(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") { authenticationFailureRef.current(); return; }
      setFormError(result.kind === "conflict" ? "На эту дату измерение уже существует." :
        result.kind === "not-found" ? "Измерение не найдено. Открой карточку повторно." :
        "Не удалось сохранить измерение. Попробуй снова.");
      return;
    }
    setWeights(current => [...current.filter(item => item.id !== result.value.id), result.value]);
    resetForm();
  }
  async function remove(id: string) {
    if (busy || !window.confirm("Удалить это измерение веса?")) return;
    setBusy(true); setFormError(null);
    const result = await deleteWeight(client.id, id);
    setBusy(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") { authenticationFailureRef.current(); return; }
      setFormError("Не удалось удалить измерение. Попробуй снова.");
      return;
    }
    setWeights(current => current.filter(item => item.id !== id));
    if (editId === id) resetForm();
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Обзор" }, { id: "trainings", label: "Тренировки" }, { id: "progress", label: "Прогресс" },
  ];
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-2 sm:p-6" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="server-client-card-title" className="mx-auto max-w-3xl rounded-3xl bg-white p-4 shadow-xl sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-xs text-zinc-500">Карточка клиента · данные сервера</p>
            <h2 id="server-client-card-title" className="mt-1 text-xl font-semibold sm:text-2xl">{client.name}</h2></div>
          <button ref={closeRef} type="button" onClick={onClose} className="min-h-11 shrink-0 rounded-xl border border-zinc-200 px-4 text-sm">Закрыть</button>
        </div>
        <nav aria-label="Разделы карточки клиента" className="mt-4 flex gap-2 overflow-x-auto border-b border-zinc-200 pb-3">
          {tabs.map(item => <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => setTab(item.id)}
            className={`min-h-11 shrink-0 rounded-xl px-4 text-sm font-medium ${tab === item.id ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700"}`}>{item.label}</button>)}
        </nav>
        {loading && <p role="status" className="mt-5 text-sm text-zinc-500">Загрузка данных клиента…</p>}
        {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {!loading && !error && tab === "overview" && (
          <div className="mt-5 space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl bg-zinc-50 p-4"><p className="text-xs text-zinc-500">Начальный вес</p><p className="mt-1 text-lg font-semibold">{shownWeight(client.startingWeight)}</p></div>
              <div className="rounded-xl bg-zinc-50 p-4"><p className="text-xs text-zinc-500">Последний вес</p><p className="mt-1 text-lg font-semibold">{shownWeight(latestWeight)}</p></div>
              <div className="rounded-xl bg-zinc-50 p-4"><p className="text-xs text-zinc-500">Завершено тренировок</p><p className="mt-1 text-lg font-semibold">{completed.length}</p></div>
            </div>
            <p className="text-sm text-zinc-600">Начальный вес — исходная точка без даты, не отдельное измерение. Для графика добавь взвешивания во вкладке «Прогресс».</p>
            {completed.length > 0 && <p className="text-sm text-zinc-600">Последняя завершённая тренировка: {shownDate(completed.slice().sort((a,b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)).at(-1)!.date)}</p>}
          </div>
        )}
        {!loading && !error && tab === "trainings" && (
          <section className="mt-5 space-y-3" aria-label="История тренировок клиента">
            {workouts.length === 0 && <p className="rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">Тренировок пока нет.</p>}
            {workouts.map(item => <article key={item.id} className="rounded-xl border border-zinc-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{item.type}</h3><span className="text-xs text-zinc-500">{item.completed ? "Завершена" : "Не завершена"}</span></div>
              <p className="mt-1 text-sm text-zinc-500">{shownDate(item.date)} · {item.time.slice(0, 5)}</p>
              {item.exercises.map(exercise => <div key={exercise.id} className="mt-2 rounded-lg bg-zinc-50 p-3 text-sm">
                <strong>{exercise.name}</strong><p className="mt-1 text-zinc-600">{exercise.sets.map((set, index) => `${index + 1}: ${shownWeight(set.weight)} × ${set.reps}`).join(" · ") || "Подходов нет"}</p>
              </div>)}
            </article>)}
            <p className="text-xs text-zinc-500">Редактирование тренировок доступно в разделе «Тренировки».</p>
          </section>
        )}
        {!loading && !error && tab === "progress" && (
          <div className="mt-5 space-y-6">
            <section className="rounded-2xl border border-zinc-200 p-4">
              <h3 className="text-lg font-semibold">Динамика веса</h3>
              <p className="mt-1 text-xs text-zinc-500">Исходный вес: {shownWeight(client.startingWeight)}. Измерения сохраняются в PostgreSQL.</p>
              <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
                <label className="text-sm">Дата<input aria-label="Дата измерения" type="date" required value={date} disabled={busy} onChange={event => setDate(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3" /></label>
                <label className="text-sm">Вес, кг<input aria-label="Вес измерения" type="text" inputMode="decimal" required value={weight} disabled={busy} onChange={event => setWeight(event.target.value)} placeholder="Например, 72,5" className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3" /></label>
                <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-zinc-900 px-4 text-sm text-white disabled:opacity-50">{busy ? "Сохраняем…" : editId ? "Сохранить" : "Добавить"}</button>
              </form>
              {editId && <button type="button" onClick={resetForm} disabled={busy} className="mt-2 min-h-11 text-sm text-zinc-600 underline">Отменить изменение</button>}
              {formError && <p role="alert" className="mt-2 text-sm text-red-600">{formError}</p>}
              {trend.count === 0 ? <p className="mt-4 text-sm text-zinc-500">Пока нет взвешиваний.</p> : (
                <figure className="mt-4 rounded-xl bg-zinc-50 p-3">
                  <figcaption className="text-sm text-zinc-600">{trend.count === 1 ? "Для динамики нужно хотя бы два измерения." : `Изменение веса: ${shownWeight(trend.first!.value)} → ${shownWeight(trend.latest!.value)} (${trend.delta! > 0 ? "+" : ""}${shownWeight(trend.delta!)}).`}</figcaption>
                  <svg viewBox="0 0 640 180" className="mt-3 h-40 w-full" role="img" aria-label="График изменения веса">
                    <line x1="20" y1="90" x2="620" y2="90" stroke="currentColor" className="text-zinc-200" />
                    {points.length > 1 && <polyline points={points.map(point => `${point.x},${point.y}`).join(" ")} stroke="currentColor" strokeWidth="4" fill="none" className="text-zinc-900" />}
                    {points.map(point => <circle key={point.index} cx={point.x} cy={point.y} r="5" fill="currentColor" className="text-zinc-900" />)}
                  </svg>
                  <div className="mt-1 flex justify-between text-xs text-zinc-500"><span>{shownDate(orderedWeights[0].date)}</span><span>{shownDate(orderedWeights.at(-1)!.date)}</span></div>
                </figure>
              )}
              <ul className="mt-4 space-y-2">
                {orderedWeights.map(item => <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-100 p-2 text-sm">
                  <span className="text-zinc-500">{shownDate(item.date)}</span><span className="mr-auto font-medium">{shownWeight(item.weight)}</span>
                  <button type="button" disabled={busy} className="min-h-11 px-2 text-violet-700" onClick={() => { setEditId(item.id); setDate(item.date); setWeight(String(item.weight)); setFormError(null); }}>Изменить</button>
                  <button type="button" disabled={busy} className="min-h-11 px-2 text-red-700" onClick={() => void remove(item.id)}>Удалить</button>
                </li>)}
              </ul>
            </section>
            <ClientProgressSection progress={progress} />
          </div>
        )}
      </div>
    </div>
  );
}
