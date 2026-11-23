"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listClients, type ServerClient } from "../lib/clients/client-api";
import { cancelAppointment, createAppointment, listAppointments, rescheduleAppointment, type AppointmentErrorKind, type ServerAppointment } from "../lib/appointments/appointment-api";
import { appointmentRanges, localDateKey, localDateTimeFields, monthGrid, monthNames, resolveLocalDateTime, weekDays } from "../lib/appointments/calendar-date";
import type { AppointmentWorkoutTarget } from "../lib/workouts/appointment-navigation";
import { appointmentHistory, type HistoryFilter } from "../lib/appointments/appointment-history";

type Props = { onAuthenticationFailure: () => void; onOpenWorkout?: (appointment: AppointmentWorkoutTarget) => void };
type LoadStatus = "loading" | "ready" | "error";

const messages: Record<Exclude<AppointmentErrorKind, "aborted">, string> = {
  validation: "Проверьте клиента, дату и время окончания.",
  unauthorized: "Сеанс завершён. Войдите снова.",
  "not-found": "Запись не найдена или больше недоступна.",
  conflict: "Это время пересекается с другой активной записью.",
  unavailable: "Расписание временно недоступно. Возможно, серверное хранилище ещё не подготовлено.",
  network: "Не удалось подключиться к серверу. Проверьте сеть и попробуйте ещё раз.",
};

const invalidLocalTime = {
  invalid: "Проверьте дату и время.",
  nonexistent: "Это местное время не существует из-за перехода на летнее время. Выберите другое время.",
  ambiguous: "Это местное время повторяется при переходе на зимнее время. Выберите однозначное время.",
} as const;

function timeValue(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function durationText(item: ServerAppointment) {
  const minutes = Math.round((Date.parse(item.endsAt) - Date.parse(item.startsAt)) / 60_000);
  return `${minutes} мин`;
}

export function ServerCalendar({ onAuthenticationFailure, onOpenWorkout }: Props) {
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(today);
  const [appointments, setAppointments] = useState<ServerAppointment[]>([]);
  const [clients, setClients] = useState<ServerClient[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [messageError, setMessageError] = useState(false);
  const [editing, setEditing] = useState<ServerAppointment | "new" | null>(null);
  const [clientId, setClientId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("10:00");
  const [saving, setSaving] = useState(false);
  const [confirmCancellation, setConfirmCancellation] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const authFailureRef = useRef(onAuthenticationFailure);
  const originalTimesRef = useRef<null | { start: ReturnType<typeof localDateTimeFields>; end: ReturnType<typeof localDateTimeFields>; startsAt: string; endsAt: string }>(null);
  const grid = useMemo(() => monthGrid(month), [month]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "локальное время браузера";

  useEffect(() => { authFailureRef.current = onAuthenticationFailure; }, [onAuthenticationFailure]);

  const startRequest = useCallback(() => {
    const generation = ++generationRef.current;
    for (const active of controllersRef.current) active.abort();
    controllersRef.current.clear();
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return { generation, controller };
  }, []);

  const current = useCallback((generation: number) => mountedRef.current && generationRef.current === generation, []);

  const load = useCallback(async (quiet = false, days = grid) => {
    const { generation, controller } = startRequest();
    if (!quiet) { setStatus("loading"); setAppointments([]); setClients([]); }
    setMessage(null); setMessageError(false);
    const [clientResult, ...rangeResults] = await Promise.all([
      listClients(fetch, controller.signal),
      ...appointmentRanges(days).map((range) => listAppointments(range.from, range.to, fetch, controller.signal)),
    ]);
    controllersRef.current.delete(controller);
    if (!current(generation)) return;
    const failed = [clientResult, ...rangeResults].find((result) => !result.ok);
    if (failed && !failed.ok) {
      if (failed.kind === "aborted") return;
      if (failed.kind === "unauthorized") { setAppointments([]); setClients([]); authFailureRef.current(); return; }
      setStatus("error"); setMessageError(true);
      setMessage(failed.kind === "network" ? messages.network : messages.unavailable);
      return;
    }
    if (!clientResult.ok) return;
    const byId = new Map<string, ServerAppointment>();
    for (const result of rangeResults) if (result.ok) for (const item of result.value) byId.set(item.id, item);
    setClients(clientResult.value);
    setAppointments([...byId.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
    setStatus("ready");
  }, [current, grid, startRequest]);

  useEffect(() => {
    mountedRef.current = true;
    queueMicrotask(() => { if (mountedRef.current) void load(); });
    const controllers = controllersRef.current;
    return () => { mountedRef.current = false; generationRef.current += 1; for (const controller of controllers) controller.abort(); controllers.clear(); };
  }, [load]);

  function showEditor(item: ServerAppointment | "new") {
    setMessage(null); setConfirmCancellation(false); setEditing(item);
    if (item === "new") {
      const date = localDateKey(selectedDate);
      originalTimesRef.current = null;
      setClientId(clients[0]?.id ?? ""); setStartDate(date); setStartTime("09:00"); setEndDate(date); setEndTime("10:00"); return;
    }
    const start = localDateTimeFields(item.startsAt); const end = localDateTimeFields(item.endsAt);
    originalTimesRef.current = { start, end, startsAt: item.startsAt, endsAt: item.endsAt };
    setClientId(item.clientId); setStartDate(start.date); setStartTime(start.time); setEndDate(end.date); setEndTime(end.time);
  }

  async function save(event: FormEvent) {
    event.preventDefault(); if (!editing || saving) return;
    const original = editing === "new" ? null : originalTimesRef.current;
    const startUnchanged = original?.start.date === startDate && original.start.time === startTime;
    const endUnchanged = original?.end.date === endDate && original.end.time === endTime;
    const resolvedStart = startUnchanged && original ? { ok: true as const, value: new Date(original.startsAt) } : resolveLocalDateTime(startDate, startTime);
    const resolvedEnd = endUnchanged && original ? { ok: true as const, value: new Date(original.endsAt) } : resolveLocalDateTime(endDate, endTime);
    if (!clientId) { setMessageError(true); setMessage(messages.validation); return; }
    if (!resolvedStart.ok) { setMessageError(true); setMessage(invalidLocalTime[resolvedStart.reason]); return; }
    if (!resolvedEnd.ok) { setMessageError(true); setMessage(invalidLocalTime[resolvedEnd.reason]); return; }
    if (resolvedEnd.value.getTime() <= resolvedStart.value.getTime()) { setMessageError(true); setMessage("Окончание должно быть позже начала."); return; }
    const startsAt = startUnchanged && original ? original.startsAt : resolvedStart.value.toISOString();
    const endsAt = endUnchanged && original ? original.endsAt : resolvedEnd.value.toISOString();
    const { generation, controller } = startRequest(); setSaving(true); setMessage(null); setMessageError(false);
    const result = editing === "new"
      ? await createAppointment(clientId, startsAt, endsAt, fetch, controller.signal)
      : await rescheduleAppointment(editing.id, startsAt, endsAt, fetch, controller.signal);
    controllersRef.current.delete(controller); if (!current(generation)) return; setSaving(false);
    if (!result.ok) {
      if (result.kind === "aborted") return;
      if (result.kind === "unauthorized") { setAppointments([]); setClients([]); authFailureRef.current(); return; }
      setMessageError(true); setMessage(messages[result.kind]); return;
    }
    const destination = resolvedStart.value;
    setEditing(null); setSelectedDate(destination); setMonth(new Date(destination.getFullYear(), destination.getMonth(), 1));
    await load(true, monthGrid(new Date(destination.getFullYear(), destination.getMonth(), 1)));
    if (!mountedRef.current) return;
    setMessageError(false); setMessage(editing === "new" ? "Запись создана." : "Время записи изменено.");
  }

  async function cancel() {
    if (!editing || editing === "new" || saving) return;
    const { generation, controller } = startRequest(); setSaving(true); setMessage(null);
    const result = await cancelAppointment(editing.id, fetch, controller.signal);
    controllersRef.current.delete(controller); if (!current(generation)) return; setSaving(false);
    if (!result.ok) {
      if (result.kind === "aborted") return;
      if (result.kind === "unauthorized") { setAppointments([]); setClients([]); authFailureRef.current(); return; }
      setMessageError(true); setMessage(messages[result.kind]); return;
    }
    setEditing(null); setConfirmCancellation(false); await load(true);
    if (!mountedRef.current) return;
    setMessageError(false); setMessage("Запись отменена. Она сохранена в истории со статусом «отменена».");
  }

  const active = appointments.filter((item) => item.status === "active");
  const selected = active.filter((item) => localDateKey(new Date(item.startsAt)) === localDateKey(selectedDate));
  const history = appointmentHistory(appointments, month, new Date());
  const visibleHistory = history.filter((item) => historyFilter === "all" || item.historyStatus === historyFilter);

  return <div className="px-3 py-4 sm:px-6 sm:py-6">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-medium uppercase tracking-[0.16em] text-violet-600">Серверное расписание</p><h1 className="mt-1 text-2xl font-semibold">Календарь</h1><p className="mt-1 text-xs text-zinc-500">Время: {timezone}</p></div>
      <button type="button" onClick={() => showEditor("new")} disabled={status !== "ready" || clients.length === 0} className="min-h-11 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-40">+ Запись</button>
    </header>
    {message && <p role={messageError ? "alert" : "status"} className={`mt-4 rounded-xl p-3 text-sm ${messageError ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>{message}</p>}
    {status === "loading" && <p role="status" className="mt-4 rounded-xl bg-white p-4 text-sm text-zinc-500 ring-1 ring-zinc-200">Загружаем расписание…</p>}
    {status === "error" && <button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-xl border border-zinc-200 bg-white px-4 text-sm font-medium">Повторить</button>}

    <section aria-labelledby="server-calendar-month" className="mt-4 rounded-2xl bg-white px-1 py-3 shadow-sm ring-1 ring-zinc-200 sm:mt-8 sm:rounded-3xl sm:p-5">
      <div className="flex items-center justify-between gap-2 px-2 pb-3 sm:px-0">
        <button type="button" aria-label="Предыдущий месяц" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="h-11 w-11 rounded-xl text-xl hover:bg-zinc-100">‹</button>
        <div className="text-center"><div id="server-calendar-month" aria-live="polite" className="font-semibold">{monthNames[month.getMonth()]} {month.getFullYear()}</div><button type="button" onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); setSelectedDate(now); }} className="mt-1 min-h-8 text-xs font-medium text-violet-700">Сегодня</button></div>
        <button type="button" aria-label="Следующий месяц" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="h-11 w-11 rounded-xl text-xl hover:bg-zinc-100">›</button>
      </div>
      <div className="grid grid-cols-7">{weekDays.map((day) => <div key={day} className="py-1.5 text-center text-[10px] font-medium text-zinc-400 sm:text-xs">{day}</div>)}</div>
      <div className="grid grid-cols-7 gap-0.5 sm:gap-1">{grid.map((date) => {
        const key = localDateKey(date); const count = active.filter((item) => localDateKey(new Date(item.startsAt)) === key).length;
        const isSelected = localDateKey(selectedDate) === key; const isToday = localDateKey(today) === key; const outside = date.getMonth() !== month.getMonth();
        return <button key={key} type="button" aria-pressed={isSelected} aria-current={isToday ? "date" : undefined} aria-label={`${date.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}, записей: ${count}`} onClick={() => setSelectedDate(date)} className={`relative flex h-11 flex-col items-center justify-center rounded-xl transition sm:h-16 sm:rounded-2xl ${isSelected ? "bg-zinc-900 text-white" : "hover:bg-zinc-100"} ${outside && !isSelected ? "text-zinc-400" : ""}`}><span className="text-xs font-semibold sm:text-sm">{date.getDate()}</span>{count > 0 ? <span className={`mt-0.5 min-w-4 rounded-full px-1 text-[10px] font-semibold ${isSelected ? "bg-white/20" : "bg-violet-100 text-violet-700"}`}>{count}</span> : isToday && !isSelected ? <span className="mt-1 h-1.5 w-1.5 rounded-full bg-zinc-900" /> : null}</button>;
      })}</div>
    </section>

    <section className="mt-6" aria-labelledby="selected-schedule"><div className="flex items-end justify-between gap-2"><div><p className="text-xs text-zinc-500">Расписание</p><h2 id="selected-schedule" className="mt-1 text-xl font-semibold">{selectedDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}</h2></div><span className="text-xs text-zinc-500">{selected.length} записей</span></div>
      {status === "ready" && selected.length === 0 && <div className="mt-3 rounded-2xl bg-white p-7 text-center shadow-sm ring-1 ring-zinc-200"><p className="text-sm font-medium">Записей нет</p><p className="mt-1 text-xs text-zinc-500">Выберите клиента и добавьте запись</p></div>}
      <div className="mt-3 space-y-2">{selected.map((item) => <div key={item.id} className="flex items-stretch gap-2 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-zinc-200 sm:p-3">
        <button type="button" onClick={() => showEditor(item)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left hover:bg-zinc-50">
          <span className="w-12 shrink-0 text-sm font-semibold sm:w-16 sm:text-lg">{timeValue(item.startsAt)}</span>
          <span className="h-9 w-px bg-zinc-200" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold sm:text-base">{item.clientName ?? clients.find((client) => client.id === item.clientId)?.name ?? "Клиент"}</span><span className="mt-0.5 block text-xs text-zinc-500">Персональная тренировка · {durationText(item)}</span></span>
        </button>
        {onOpenWorkout && <button type="button" onClick={() => onOpenWorkout(item)} className="min-h-11 shrink-0 rounded-xl bg-violet-50 px-3 text-xs font-semibold text-violet-800 hover:bg-violet-100 sm:text-sm">К тренировке</button>}
      </div>)}</div>
    </section>

    <section aria-labelledby="appointment-history-heading" className="mt-7 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 sm:mt-8 sm:rounded-3xl sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="appointment-history-heading" className="text-xl font-semibold">История записей</h2>
          <p className="mt-1 text-xs text-zinc-500">За {monthNames[month.getMonth()].toLowerCase()} {month.getFullYear()} года · {history.length} записей</p>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Фильтр истории записей">
          {([ ["all", "Все"], ["past", "Прошедшие"], ["cancelled", "Отменённые"] ] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={historyFilter === value} onClick={() => setHistoryFilter(value)} className={`min-h-10 rounded-xl px-3 text-xs font-medium sm:text-sm ${historyFilter === value ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"}`}>{label}</button>
          ))}
        </div>
      </div>
      <p className="mt-3 text-xs text-zinc-500">Прошедшая запись — это время, которое закончилось. Она не обязательно означает, что тренировка состоялась. Для другого месяца переключите календарь выше.</p>
      {status === "ready" && visibleHistory.length === 0 && <p className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">За выбранный месяц записей с таким статусом нет.</p>}
      {status === "ready" && visibleHistory.length > 0 && (
        <div className="mt-4 space-y-2">
          {visibleHistory.map((item) => (
            <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 p-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{item.clientName ?? clients.find((client) => client.id === item.clientId)?.name ?? "Клиент"}</p>
                <p className="mt-1 text-xs text-zinc-500">{new Date(item.startsAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} · {timeValue(item.startsAt)}–{timeValue(item.endsAt)}</p>
                {item.historyStatus === "cancelled" && item.cancelledAt && <p className="mt-1 text-xs text-zinc-500">Отменена {new Date(item.cancelledAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</p>}
              </div>
              <span className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${item.historyStatus === "cancelled" ? "bg-amber-50 text-amber-800" : "bg-zinc-100 text-zinc-700"}`}>
                {item.historyStatus === "cancelled" ? "Отменена" : "Время прошло"}
              </span>
            </article>
          ))}
        </div>
      )}
    </section>

    {editing && <div className="fixed inset-0 z-50 flex items-end bg-black/40 p-3 sm:items-center sm:justify-center" role="presentation"><div role="dialog" aria-modal="true" aria-labelledby="appointment-editor-title" className="w-full max-w-md rounded-3xl bg-white p-5 shadow-xl"><div className="flex items-center justify-between"><div><p className="text-xs text-zinc-500">Дата и время записи</p><h2 id="appointment-editor-title" className="mt-1 text-xl font-semibold">{editing === "new" ? "Новая запись" : "Изменить запись"}</h2></div><button type="button" aria-label="Закрыть" disabled={saving} onClick={() => setEditing(null)} className="h-11 w-11 rounded-xl text-xl text-zinc-400">×</button></div>
      <form noValidate onSubmit={save} className="mt-5 space-y-4"><div><label htmlFor="appointment-client" className="text-sm font-medium">Клиент</label><select id="appointment-client" value={clientId} disabled={saving || editing !== "new"} onChange={(event) => setClientId(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3"><option value="">Выберите клиента</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></div><fieldset><legend className="text-sm font-medium">Начало</legend><div className="mt-1 grid grid-cols-2 gap-3"><input aria-label="Дата начала" type="date" value={startDate} disabled={saving} onChange={(event) => setStartDate(event.target.value)} className="min-h-11 w-full rounded-xl border border-zinc-200 px-3" /><input aria-label="Время начала" type="time" value={startTime} disabled={saving} onChange={(event) => setStartTime(event.target.value)} className="min-h-11 w-full rounded-xl border border-zinc-200 px-3" /></div></fieldset><fieldset><legend className="text-sm font-medium">Окончание</legend><div className="mt-1 grid grid-cols-2 gap-3"><input aria-label="Дата окончания" type="date" value={endDate} disabled={saving} onChange={(event) => setEndDate(event.target.value)} className="min-h-11 w-full rounded-xl border border-zinc-200 px-3" /><input aria-label="Время окончания" type="time" value={endTime} disabled={saving} onChange={(event) => setEndTime(event.target.value)} className="min-h-11 w-full rounded-xl border border-zinc-200 px-3" /></div></fieldset><p className="text-xs text-zinc-500">Время указано в зоне {timezone}.</p><div className="flex gap-2"><button type="button" disabled={saving} onClick={() => setEditing(null)} className="min-h-11 flex-1 rounded-xl border border-zinc-200 px-4">Закрыть</button><button type="submit" disabled={saving} className="min-h-11 flex-1 rounded-xl bg-zinc-900 px-4 text-white disabled:opacity-40">{saving ? "Сохраняем…" : editing === "new" ? "Создать" : "Сохранить"}</button></div></form>
      {editing !== "new" && onOpenWorkout && <button type="button" disabled={saving} onClick={() => onOpenWorkout(editing)} className="mt-4 min-h-11 w-full rounded-xl bg-violet-50 px-4 text-sm font-semibold text-violet-800">Открыть тренировку клиента</button>}
      {editing !== "new" && (confirmCancellation ? <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"><h3 className="font-semibold text-amber-950">Отменить запись?</h3><p className="mt-1 text-sm text-amber-900">Запись не удаляется: сервер сохранит её со статусом «отменена».</p><div className="mt-3 flex gap-2"><button type="button" disabled={saving} onClick={() => setConfirmCancellation(false)} className="min-h-11 flex-1 rounded-xl border border-zinc-200 bg-white px-3">Не отменять</button><button type="button" disabled={saving} onClick={() => void cancel()} className="min-h-11 flex-1 rounded-xl bg-amber-700 px-3 text-white">{saving ? "Отменяем…" : "Отменить запись"}</button></div></section> : <button type="button" onClick={() => setConfirmCancellation(true)} className="mt-4 min-h-11 w-full rounded-xl bg-amber-50 px-4 text-sm font-medium text-amber-800">Отменить запись</button>)}</div></div>}
  </div>;
}
