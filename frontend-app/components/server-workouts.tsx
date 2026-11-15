"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { listClients, type ServerClient } from "../lib/clients/client-api";
import { listWorkouts, saveWorkout, type Workout, type WorkoutInput } from "../lib/workouts/workout-api";

type DraftSet = { key: number; weight: string; reps: string };
type DraftExercise = { key: number; name: string; sets: DraftSet[] };
type Draft = { id?: string; date: string; time: string; type: string; completed: boolean; exercises: DraftExercise[] };
type Props = { onAuthenticationFailure: () => void };

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const emptyDraft = (): Draft => ({ date: today(), time: "09:00", type: "Персональная тренировка", completed: true, exercises: [] });
const messageFor = (kind: string) => kind === "network" ? "Не удалось подключиться к серверу. Проверьте сеть и попробуйте снова." : kind === "conflict" ? "Тренировка была изменена. Обновите историю и повторите изменения." : kind === "validation" ? "Проверьте дату, время, названия упражнений, вес и повторения." : kind === "not-found" ? "Тренировка больше недоступна. Обновите историю." : "Сервис тренировок временно недоступен. Попробуйте позже.";

export function ServerWorkouts({ onAuthenticationFailure }: Props) {
  const authFailureRef = useRef(onAuthenticationFailure);
  const nextKey = useRef(1);
  const loadGeneration = useRef(0);
  const [clients, setClients] = useState<ServerClient[]>([]);
  const [clientId, setClientId] = useState("");
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [messageError, setMessageError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { authFailureRef.current = onAuthenticationFailure; }, [onAuthenticationFailure]);
  useEffect(() => {
    let active = true;
    void listClients().then((result) => {
      if (!active) return;
      if (result.ok) {
        const firstClientId = result.value[0]?.id ?? "";
        setClients(result.value); setClientId(firstClientId);
        if (firstClientId) void load(firstClientId); else setStatus("ready");
      }
      else if (result.kind === "unauthorized") authFailureRef.current();
      else if (result.kind !== "aborted") { setStatus("error"); setMessageError(true); setMessage(messageFor(result.kind)); }
    });
    return () => { active = false; };
  }, []);

  async function load(id: string, quiet = false) {
    const generation = ++loadGeneration.current;
    if (!quiet) setStatus("loading");
    setMessage(null); setMessageError(false);
    const result = await listWorkouts(id);
    if (generation !== loadGeneration.current) return;
    if (result.ok) { setWorkouts(result.value); setStatus("ready"); return; }
    if (result.kind === "unauthorized") { setWorkouts([]); authFailureRef.current(); return; }
    if (result.kind !== "aborted") { setStatus("error"); setMessageError(true); setMessage(messageFor(result.kind)); }
  }

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function mayDiscard() { return !dirty || window.confirm("Есть несохранённые изменения. Отменить их?"); }
  function edit(workout: Workout) {
    if (!mayDiscard()) return;
    setDraft({ id: workout.id, date: workout.date, time: workout.time.slice(0, 5), type: workout.type, completed: workout.completed, exercises: workout.exercises.map((exercise) => ({ key: nextKey.current++, name: exercise.name, sets: exercise.sets.map((set) => ({ key: nextKey.current++, weight: String(set.weight), reps: String(set.reps) })) })) });
    setDirty(false); setMessage(null);
  }
  function update(change: (current: Draft) => Draft) { setDraft((current) => current ? change(current) : current); setDirty(true); setMessage(null); }
  function addExercise() { update((current) => ({ ...current, exercises: [...current.exercises, { key: nextKey.current++, name: "Новое упражнение", sets: [{ key: nextKey.current++, weight: "0", reps: "0" }] }] })); }
  function removeExercise(key: number) { update((current) => ({ ...current, exercises: current.exercises.filter((exercise) => exercise.key !== key) })); }
  function updateExercise(key: number, change: (exercise: DraftExercise) => DraftExercise) { update((current) => ({ ...current, exercises: current.exercises.map((exercise) => exercise.key === key ? change(exercise) : exercise) })); }

  function input(): WorkoutInput | null {
    if (!draft || !draft.date || !draft.time || !draft.type.trim() || draft.type.trim().length > 120 || draft.exercises.length > 50) return null;
    const exercises = draft.exercises.map((exercise) => ({ name: exercise.name.trim(), sets: exercise.sets.map((set) => ({ weight: Number(set.weight), reps: Number(set.reps) })) }));
    if (exercises.some((exercise) => !exercise.name || exercise.name.length > 120 || exercise.sets.length > 20 || exercise.sets.some((set) => !Number.isFinite(set.weight) || set.weight < 0 || set.weight > 1000 || !Number.isInteger(set.weight * 1000) || !Number.isInteger(set.reps) || set.reps < 0 || set.reps > 10000))) return null;
    return { clientId, appointmentId: null, date: draft.date, time: draft.time, type: draft.type.trim(), completed: draft.completed, caloriesBurned: null, exercises };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const payload = input();
    if (!payload) { setMessageError(true); setMessage(messageFor("validation")); return; }
    setSaving(true); setMessage(null); setMessageError(false);
    const result = await saveWorkout(payload, draft?.id);
    setSaving(false);
    if (result.ok) { setDraft(null); setDirty(false); await load(clientId, true); setMessageError(false); setMessage(draft?.id ? "Тренировка сохранена." : "Тренировка создана."); return; }
    if (result.kind === "unauthorized") { authFailureRef.current(); return; }
    if (result.kind !== "aborted") { setMessageError(true); setMessage(messageFor(result.kind)); }
  }

  return <section className="px-3 py-4 sm:px-6 sm:py-6" aria-labelledby="workouts-heading">
    <header><p className="text-xs font-medium uppercase tracking-[0.16em] text-violet-600">Пилотный кабинет тренера</p><h1 id="workouts-heading" className="mt-1 text-2xl font-semibold">Тренировки</h1></header>
    <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 sm:rounded-3xl sm:p-5">
      <label htmlFor="workout-client" className="text-sm font-medium">Клиент</label>
      <select id="workout-client" value={clientId} disabled={clients.length === 0 || saving} onChange={(event) => { if (!mayDiscard()) return; const id = event.target.value; setDraft(null); setDirty(false); setClientId(id); if (id) void load(id); }} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3 sm:max-w-md"><option value="">Выберите клиента</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select>
      {message && <p role={messageError ? "alert" : "status"} className={`mt-4 rounded-xl p-3 text-sm ${messageError ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>{message}</p>}
      {status === "loading" && <p role="status" className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">Загружаем историю тренировок…</p>}
      {status === "error" && clientId && <button type="button" onClick={() => void load(clientId)} className="mt-3 min-h-11 rounded-xl border border-zinc-200 px-4 text-sm font-medium">Повторить</button>}
      {status === "ready" && clients.length === 0 && <p className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">Сначала добавьте клиента в разделе «Клиенты».</p>}
      {status === "ready" && clientId && <div className="mt-5"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">История</h2><button type="button" disabled={saving} onClick={() => { if (mayDiscard()) { setDraft(emptyDraft()); setDirty(false); setMessage(null); } }} className="min-h-11 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-40">Новая тренировка</button></div>
        {workouts.length === 0 ? <p className="mt-3 text-sm text-zinc-500">У клиента пока нет тренировок.</p> : <ul className="mt-3 grid gap-2 sm:grid-cols-2">{workouts.map((workout) => <li key={workout.id}><button type="button" onClick={() => edit(workout)} className="min-h-16 w-full rounded-2xl border border-zinc-200 p-3 text-left hover:bg-zinc-50"><span className="block font-medium">{new Date(`${workout.date}T00:00:00`).toLocaleDateString("ru-RU")} · {workout.time.slice(0, 5)}</span><span className="mt-1 block text-sm text-zinc-500">{workout.type} · упражнений: {workout.exercises.length}</span></button></li>)}</ul>}
      </div>}
    </div>
    {draft && <form noValidate onSubmit={submit} className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 sm:rounded-3xl sm:p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">{draft.id ? "Редактирование тренировки" : "Новая тренировка"}</h2><button type="button" disabled={saving} onClick={() => { if (mayDiscard()) { setDraft(null); setDirty(false); } }} className="min-h-11 rounded-xl px-3 text-zinc-500">Закрыть</button></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3"><label className="text-sm font-medium">Дата<input type="date" value={draft.date} disabled={saving} onChange={(event) => update((current) => ({ ...current, date: event.target.value }))} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3" /></label><label className="text-sm font-medium">Время<input type="time" value={draft.time} disabled={saving} onChange={(event) => update((current) => ({ ...current, time: event.target.value }))} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3" /></label><label className="text-sm font-medium">Тип<input value={draft.type} maxLength={120} disabled={saving} onChange={(event) => update((current) => ({ ...current, type: event.target.value }))} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3" /></label></div>
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.completed} disabled={saving} onChange={(event) => update((current) => ({ ...current, completed: event.target.checked }))} />Тренировка завершена</label>
      <div className="mt-4 flex items-center justify-between"><h3 className="font-semibold">Упражнения</h3><button type="button" disabled={saving || draft.exercises.length >= 50} onClick={addExercise} className="min-h-11 rounded-xl border border-zinc-200 px-3 text-sm font-medium">Добавить упражнение</button></div>
      <div className="mt-3 space-y-3">{draft.exercises.map((exercise, exerciseIndex) => <fieldset key={exercise.key} className="rounded-2xl border border-zinc-200 p-3"><legend className="sr-only">Упражнение {exerciseIndex + 1}</legend><div className="flex gap-2"><label className="min-w-0 flex-1"><span className="sr-only">Название упражнения {exerciseIndex + 1}</span><input value={exercise.name} maxLength={120} disabled={saving} onChange={(event) => updateExercise(exercise.key, (current) => ({ ...current, name: event.target.value }))} className="min-h-11 w-full rounded-xl border border-zinc-200 px-3 font-medium" /></label><button type="button" disabled={saving} aria-label={`Удалить упражнение ${exercise.name}`} onClick={() => removeExercise(exercise.key)} className="min-h-11 rounded-xl px-3 text-sm text-red-700">Удалить</button></div>
        <div className="mt-3 space-y-2">{exercise.sets.map((set, setIndex) => <div key={set.key} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"><label className="text-xs text-zinc-500">Вес, кг<input type="number" inputMode="decimal" min="0" max="1000" step="0.001" value={set.weight} disabled={saving} onChange={(event) => updateExercise(exercise.key, (current) => ({ ...current, sets: current.sets.map((item) => item.key === set.key ? { ...item, weight: event.target.value } : item) }))} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-2 text-base" /></label><label className="text-xs text-zinc-500">Повторения<input type="number" inputMode="numeric" min="0" max="10000" step="1" value={set.reps} disabled={saving} onChange={(event) => updateExercise(exercise.key, (current) => ({ ...current, sets: current.sets.map((item) => item.key === set.key ? { ...item, reps: event.target.value } : item) }))} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-2 text-base" /></label><button type="button" disabled={saving} aria-label={`Удалить подход ${setIndex + 1}`} onClick={() => updateExercise(exercise.key, (current) => ({ ...current, sets: current.sets.filter((item) => item.key !== set.key) }))} className="min-h-11 rounded-xl px-3 text-red-700">×</button></div>)}</div>
        <button type="button" disabled={saving || exercise.sets.length >= 20} onClick={() => updateExercise(exercise.key, (current) => ({ ...current, sets: [...current.sets, { key: nextKey.current++, weight: "0", reps: "0" }] }))} className="mt-3 min-h-11 rounded-xl border border-zinc-200 px-3 text-sm">Добавить подход</button></fieldset>)}</div>
      <button type="submit" disabled={saving} className="mt-5 min-h-11 w-full rounded-xl bg-violet-600 px-4 font-medium text-white disabled:opacity-40">{saving ? "Сохраняем…" : "Сохранить тренировку"}</button>
    </form>}
  </section>;
}
