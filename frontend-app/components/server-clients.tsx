"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { listClients, postClient, type ServerClient } from "../lib/clients/client-api";
import { AppShell, type AppView } from "./app-shell";
import { ServerCalendar } from "./server-calendar";
import { ServerWorkouts } from "./server-workouts";
import { ServerClientCard } from "./server-client-card";

type Props = { onAuthenticationFailure: () => void };

export function PilotWorkspace({ trainerId, onLogout, isLoggingOut, onAuthenticationFailure }: {
  trainerId: string;
  onLogout: () => void;
  isLoggingOut: boolean;
  onAuthenticationFailure: () => void;
}) {
  const [activeView, setActiveView] = useState<AppView>("schedule");
  return (
    <AppShell activeView={activeView} onViewChange={setActiveView} onLogout={onLogout} isLoggingOut={isLoggingOut}>
      <div className="mx-auto w-full max-w-5xl">
        {activeView === "schedule" && <ServerCalendar key={`calendar-${trainerId}`} onAuthenticationFailure={onAuthenticationFailure} />}
        {activeView === "clients" && <div className="px-3 py-4 sm:px-6 sm:py-6"><header><p className="text-xs font-medium uppercase tracking-[0.16em] text-violet-600">Пилотный кабинет тренера</p><h1 className="mt-1 text-2xl font-semibold">Клиенты</h1></header><ServerClients key={`clients-${trainerId}`} onAuthenticationFailure={onAuthenticationFailure} /><section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><h2 className="font-semibold">Данные пилота</h2><p className="mt-1">Тренировки доступны в отдельном разделе. История веса и графики прогресса — в карточке клиента.</p><p className="mt-2 text-xs text-amber-800">Прежние локальные записи не загружаются, не объединяются с серверными клиентами и не изменяются.</p></section></div>}
        {activeView === "workouts" && <ServerWorkouts key={`workouts-${trainerId}`} onAuthenticationFailure={onAuthenticationFailure} />}
      </div>
    </AppShell>
  );
}

const unavailableMessage = "База данных клиентов временно недоступна. Попробуйте ещё раз позже.";
const networkMessage = "Не удалось подключиться к серверу. Проверьте сеть и попробуйте ещё раз.";

export function ServerClients({ onAuthenticationFailure }: Props) {
  const authenticationFailureRef = useRef(onAuthenticationFailure);
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const [clients, setClients] = useState<ServerClient[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [isErrorMessage, setIsErrorMessage] = useState(false);
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [weight, setWeight] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; startingWeight?: string }>({});

  useEffect(() => {
    authenticationFailureRef.current = onAuthenticationFailure;
  }, [onAuthenticationFailure]);

  function startRequest() {
    const generation = ++requestGenerationRef.current;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return { controller, generation };
  }

  function isCurrent(generation: number) {
    return mountedRef.current && requestGenerationRef.current === generation;
  }

  async function load() {
    const { controller, generation } = startRequest();
    setClients([]);
    setStatus("loading");
    setMessage(null);
    setIsErrorMessage(false);
    const result = await listClients(fetch, controller.signal);
    controllersRef.current.delete(controller);
    if (!isCurrent(generation)) return;
    if (result.ok) {
      setClients(result.value);
      setStatus("ready");
    } else if (result.kind === "unauthorized") {
      setClients([]);
      authenticationFailureRef.current();
    } else {
      setStatus("error");
      setIsErrorMessage(true);
      setMessage(result.kind === "network" ? networkMessage : unavailableMessage);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const controllers = controllersRef.current;
    const controller = new AbortController();
    const generation = ++requestGenerationRef.current;
    controllers.add(controller);
    void listClients(fetch, controller.signal).then((result) => {
      controllers.delete(controller);
      if (!mountedRef.current || requestGenerationRef.current !== generation) return;
      if (result.ok) {
        setClients(result.value);
        setStatus("ready");
      } else if (result.kind === "unauthorized") {
        setClients([]);
        authenticationFailureRef.current();
      } else if (result.kind !== "aborted") {
        setStatus("error");
        setIsErrorMessage(true);
        setMessage(result.kind === "network" ? networkMessage : unavailableMessage);
      }
    });
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      for (const activeController of controllers) activeController.abort();
      controllers.clear();
    };
  }, []); // The authenticated account is the component key.

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const normalizedName = name.trim();
    const startingWeight = Number(weight.trim());
    const errors: typeof fieldErrors = {};
    if (!normalizedName) errors.name = "Введите имя клиента.";
    else if (normalizedName.length > 120) errors.name = "Имя должно содержать не более 120 символов.";
    if (!weight.trim() || !Number.isFinite(startingWeight) || startingWeight < 0.001 || startingWeight > 1000 || !Number.isInteger(startingWeight * 1000)) {
      errors.startingWeight = "Введите вес от 0,001 до 1000 кг, не более трёх знаков после запятой.";
    }
    if (Object.keys(errors).length) { setFieldErrors(errors); return; }

    const { controller, generation } = startRequest();
    setIsSubmitting(true);
    setFieldErrors({});
    setMessage(null);
    setIsErrorMessage(false);
    const result = await postClient(normalizedName, startingWeight, fetch, controller.signal);
    controllersRef.current.delete(controller);
    if (!isCurrent(generation)) return;
    setIsSubmitting(false);
    if (result.ok) {
      setClients((current) => [...current, result.value]);
      setStatus("ready");
      setName("");
      setWeight("");
      setIsOpen(false);
      setMessage("Клиент добавлен.");
    } else if (result.kind === "unauthorized") {
      setClients([]);
      authenticationFailureRef.current();
    } else if (result.kind === "validation") {
      const recognizedErrors = {
        name: result.fieldErrors.name ? "Проверьте имя клиента." : undefined,
        startingWeight: result.fieldErrors.startingWeight ? "Проверьте начальный вес." : undefined,
      };
      setFieldErrors(recognizedErrors);
      if (!recognizedErrors.name && !recognizedErrors.startingWeight) {
        setIsErrorMessage(true);
        setMessage("Не удалось проверить данные клиента. Проверьте введённые значения и попробуйте снова.");
      }
    } else if (result.kind !== "aborted") {
      setStatus("error");
      setIsErrorMessage(true);
      setMessage(result.kind === "network" ? networkMessage : unavailableMessage);
    }
  }

  const filtered = clients.filter((client) => client.name.toLocaleLowerCase("ru").includes(search.trim().toLocaleLowerCase("ru")));

  return (
    <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 sm:mt-8 sm:rounded-3xl sm:p-5" aria-labelledby="clients-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-xs text-zinc-500 sm:text-sm">Сохранены на сервере</p><h2 id="clients-heading" className="mt-1 text-xl font-semibold sm:text-2xl">Клиенты</h2></div>
        <div className="flex w-full flex-col gap-2 sm:max-w-md sm:flex-row">
          <label htmlFor="server-client-search" className="sr-only">Поиск клиента</label>
          <input id="server-client-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск клиента..." className="min-h-11 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-base outline-none focus:border-violet-500 sm:text-sm" />
          <button type="button" onClick={() => { setIsOpen(true); setFieldErrors({}); setMessage(null); }} disabled={status === "loading"} className="min-h-11 shrink-0 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40">Добавить клиента</button>
        </div>
      </div>

      {message && <p role={isErrorMessage ? "alert" : "status"} className={`mt-4 rounded-xl p-3 text-sm ${isErrorMessage ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>{message}</p>}
      {status === "loading" && <p role="status" aria-live="polite" className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">Загружаем клиентов…</p>}
      {status === "error" && <button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium">Повторить</button>}
      {status === "ready" && clients.length === 0 && <p className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">Клиентов пока нет. Добавьте первого клиента.</p>}
      {status === "ready" && clients.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((client) => <button type="button" key={client.id} onClick={() => setSelectedClientId(client.id)} aria-label={`Открыть карточку: ${client.name}`} className="flex min-h-16 items-center gap-3 rounded-2xl border border-zinc-200 p-3 text-left hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-violet-500"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-semibold text-white">{client.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</div><div className="min-w-0"><div className="truncate text-sm font-semibold">{client.name}</div><div className="mt-0.5 text-xs text-zinc-500">Начальный вес: {client.startingWeight} кг</div></div></button>)}
          {filtered.length === 0 && <p className="text-sm text-zinc-500">По вашему запросу ничего не найдено.</p>}
        </div>
      )}

      {selectedClientId && clients.some(client => client.id === selectedClientId) && <ServerClientCard key={selectedClientId} client={clients.find(client => client.id === selectedClientId)!} onClose={() => setSelectedClientId(null)} onAuthenticationFailure={onAuthenticationFailure} />}

      {isOpen && <div className="fixed inset-0 z-50 flex items-end bg-black/40 p-3 sm:items-center sm:justify-center" role="presentation"><div role="dialog" aria-modal="true" aria-labelledby="create-server-client-heading" className="w-full max-w-md rounded-3xl bg-white p-5 shadow-xl"><h3 id="create-server-client-heading" className="text-xl font-semibold">Новый клиент</h3><form noValidate onSubmit={submit} className="mt-4 space-y-4"><div><label htmlFor="server-client-name" className="text-sm font-medium">Имя</label><input id="server-client-name" value={name} disabled={isSubmitting} onChange={(event) => { setName(event.target.value); setFieldErrors((current) => ({ ...current, name: undefined })); }} aria-invalid={!!fieldErrors.name} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3" />{fieldErrors.name && <p role="alert" className="mt-1 text-sm text-red-600">{fieldErrors.name}</p>}</div><div><label htmlFor="server-client-weight" className="text-sm font-medium">Начальный вес, кг</label><input id="server-client-weight" type="number" inputMode="decimal" min="0.001" max="1000" step="0.001" value={weight} disabled={isSubmitting} onChange={(event) => { setWeight(event.target.value); setFieldErrors((current) => ({ ...current, startingWeight: undefined })); }} aria-invalid={!!fieldErrors.startingWeight} className="mt-1 min-h-11 w-full rounded-xl border border-zinc-200 px-3" />{fieldErrors.startingWeight && <p role="alert" className="mt-1 text-sm text-red-600">{fieldErrors.startingWeight}</p>}</div><div className="flex gap-2"><button type="button" disabled={isSubmitting} onClick={() => setIsOpen(false)} className="min-h-11 flex-1 rounded-xl border border-zinc-200 px-4">Отмена</button><button type="submit" disabled={isSubmitting} className="min-h-11 flex-1 rounded-xl bg-zinc-900 px-4 text-white disabled:opacity-40">{isSubmitting ? "Сохраняем…" : "Добавить"}</button></div></form></div></div>}
      <p className="mt-4 text-xs text-zinc-500">Серверные UUID используются отдельно от прежних локальных записей.</p>
    </section>
  );
}
