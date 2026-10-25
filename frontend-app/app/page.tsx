"use client";

import { useEffect, useRef, useState } from "react";
import { AppShell, type AppView } from "../components/app-shell";
import { ClientProgressSection } from "../components/client-progress-section";
import type {
  Client,
  TrainerCrmData,
  Training,
  TrainingExercises,
} from "../lib/domain/trainer-crm";
import { buildClientProgress } from "../lib/progress/client-progress";
import { TrainerCrmRepository } from "../lib/storage/trainer-crm-repository";

type WeightPoint = {
  date: string;
  weight: number;
};

type ClientDetailSection = "overview" | "trainings" | "progress";

const initialClients: Client[] = [
  { id: 1, name: "Анна Петрова", weight: 72.4, startWeight: 76 },
  { id: 2, name: "Сергей Иванов", weight: 91.2, startWeight: 94 },
  { id: 3, name: "Мария Смирнова", weight: 64.8, startWeight: 67.5 },
  { id: 4, name: "Алексей Волков", weight: 83.6, startWeight: 83.6 },
  { id: 5, name: "Елена Кузнецова", weight: 58.9, startWeight: 61 },
  { id: 6, name: "Дмитрий Орлов", weight: 97.3, startWeight: 99 },
  { id: 7, name: "Ольга Морозова", weight: 69.7, startWeight: 72 },
  { id: 8, name: "Иван Соколов", weight: 88.5, startWeight: 88.5 },
];

const initialTrainingExercises: TrainingExercises = {
  1: [
    { id: 1, name: "Приседания", sets: [{ id: 1, weight: 40, reps: 12 }, { id: 2, weight: 45, reps: 10 }, { id: 3, weight: 45, reps: 10 }] },
    { id: 2, name: "Жим ногами", sets: [{ id: 1, weight: 80, reps: 12 }, { id: 2, weight: 90, reps: 10 }] },
    { id: 3, name: "Тяга верхнего блока", sets: [{ id: 1, weight: 35, reps: 12 }, { id: 2, weight: 40, reps: 10 }] },
  ],
  9: [
    { id: 1, name: "Приседания", sets: [{ id: 1, weight: 45, reps: 10 }, { id: 2, weight: 47.5, reps: 10 }, { id: 3, weight: 50, reps: 8 }] },
    { id: 2, name: "Жим ногами", sets: [{ id: 1, weight: 90, reps: 10 }, { id: 2, weight: 95, reps: 10 }] },
    { id: 3, name: "Тяга верхнего блока", sets: [{ id: 1, weight: 40, reps: 10 }, { id: 2, weight: 45, reps: 10 }] },
  ],
};

const clientWeightHistory: Record<number, WeightPoint[]> = {
  1: [
    { date: "2026-07-18", weight: 76 },
    { date: "2026-07-25", weight: 74.8 },
    { date: "2026-08-01", weight: 73.6 },
    { date: "2026-08-11", weight: 72.4 },
  ],
  2: [
    { date: "2026-07-20", weight: 94 },
    { date: "2026-08-03", weight: 92.5 },
    { date: "2026-08-11", weight: 91.2 },
  ],
};

const initialTrainings: Training[] = [
  {
    id: 1,
    clientId: 1,
    clientName: "Анна Петрова",
    date: "2026-08-11",
    time: "09:00",
    type: "Персональная тренировка",
    completed: true,
  },
  {
    id: 2,
    clientId: 2,
    clientName: "Сергей Иванов",
    date: "2026-08-11",
    time: "11:00",
    type: "Персональная тренировка",
    completed: true,
  },
  {
    id: 3,
    clientId: 3,
    clientName: "Мария Смирнова",
    date: "2026-08-13",
    time: "09:00",
    type: "Персональная тренировка",
    completed: true,
  },
  {
    id: 4,
    clientId: 4,
    clientName: "Алексей Волков",
    date: "2026-08-13",
    time: "09:00",
    type: "Персональная тренировка",
    completed: true,
  },
  {
    id: 5,
    clientId: 5,
    clientName: "Елена Кузнецова",
    date: "2026-08-13",
    time: "09:00",
    type: "Персональная тренировка",
    completed: true,
  },
  {
    id: 6,
    clientId: 6,
    clientName: "Дмитрий Орлов",
    date: "2026-08-13",
    time: "18:00",
    type: "Персональная тренировка",
    completed: true,
  },
  {
    id: 7,
    clientId: 7,
    clientName: "Ольга Морозова",
    date: "2026-08-15",
    time: "10:00",
    type: "Персональная тренировка",
    completed: true,
  },
  {
    id: 8,
    clientId: 8,
    clientName: "Иван Соколов",
    date: "2026-08-15",
    time: "12:00",
    type: "Персональная тренировка",
    completed: true,
  },
  {
    id: 9,
    clientId: 1,
    clientName: "Анна Петрова",
    date: "2026-08-18",
    time: "09:00",
    type: "Персональная тренировка",
    completed: false,
  },
  {
    id: 10,
    clientId: 2,
    clientName: "Сергей Иванов",
    date: "2026-08-20",
    time: "17:00",
    type: "Персональная тренировка",
    completed: false,
  },
];

const monthNames = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

const weekDays = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getCalendarDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);

  let startDay = firstDay.getDay();

  if (startDay === 0) {
    startDay = 7;
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const days: (Date | null)[] = [];

  for (let i = 1; i < startDay; i++) {
    days.push(null);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    days.push(new Date(year, month, day));
  }

  return days;
}

function getTrainingWord(count: number) {
  if (count % 10 === 1 && count % 100 !== 11) {
    return "тренировка";
  }

  if (
    count % 10 >= 2 &&
    count % 10 <= 4 &&
    (count % 100 < 10 || count % 100 >= 20)
  ) {
    return "тренировки";
  }

  return "тренировок";
}

function formatShortDate(value: string) {
  const [, month, day] = value.split("-");
  return `${day}.${month}`;
}

export default function Home() {
  const today = new Date();

  const [isHydrated, setIsHydrated] = useState(false);

  const [currentMonth, setCurrentMonth] = useState(
    new Date(today.getFullYear(), today.getMonth(), 1)
  );

  const [selectedDate, setSelectedDate] = useState(today);
  
  const [clients, setClients] = useState<Client[]>(initialClients);
  const [trainings, setTrainings] = useState<Training[]>(initialTrainings);

  const [selectedTraining, setSelectedTraining] =
    useState<Training | null>(null);

  const [trainingExercises, setTrainingExercises] =
    useState<TrainingExercises>(initialTrainingExercises);
  const repositoryRef = useRef<TrainerCrmRepository | null>(null);
  const skipLoadedDataSaveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let loadedData: TrainerCrmData | null = null;

    try {
      const repository = new TrainerCrmRepository(window.localStorage);
      repositoryRef.current = repository;

      const result = repository.load({
        clients: initialClients,
        trainings: initialTrainings,
        exercises: initialTrainingExercises,
      });

      skipLoadedDataSaveRef.current = true;
      loadedData = result.data;

      if (result.issues.length > 0) {
        console.error("TrainerCRM storage load completed with issues.", result.issues);
      }
    } catch (error) {
      repositoryRef.current = null;
      console.error("TrainerCRM storage is unavailable; using in-memory data.", error);
    } finally {
      queueMicrotask(() => {
        if (cancelled) return;

        if (loadedData) {
          setClients(loadedData.clients);
          setTrainings(loadedData.trainings);
          setTrainingExercises(loadedData.exercises);
        }
        setIsHydrated(true);
      });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const repository = repositoryRef.current;
    if (!isHydrated || !repository) return;

    if (skipLoadedDataSaveRef.current) {
      skipLoadedDataSaveRef.current = false;
      return;
    }

    const data: TrainerCrmData = {
      clients,
      trainings,
      exercises: trainingExercises,
    };
    const result = repository.save(data);

    if (!result.ok) {
      console.error("TrainerCRM storage save was not fully successful.", result);
    }
  }, [clients, trainings, trainingExercises, isHydrated]);

  const [selectedClient, setSelectedClient] =
    useState<Client | null>(null);

  const [clientSearch, setClientSearch] =
    useState("");

  const [isAddModalOpen, setIsAddModalOpen] =
    useState(false);

  const [newClientId, setNewClientId] =
    useState("");

  const [newTime, setNewTime] =
    useState("09:00");

  const [activeView, setActiveView] = useState<AppView>("schedule");
  const [clientDetailSection, setClientDetailSection] =
    useState<ClientDetailSection>("overview");
  const addDialogRef = useRef<HTMLDivElement | null>(null);
  const clientDialogRef = useRef<HTMLDivElement | null>(null);
  const trainingDialogRef = useRef<HTMLDivElement | null>(null);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const calendarDays =
    getCalendarDays(year, month);

  const selectedKey =
    formatDate(selectedDate);

  const selectedTrainings =
    trainings
      .filter(
        (training) =>
          training.date === selectedKey
      )
      .sort((a, b) =>
        a.time.localeCompare(b.time)
      );

  const filteredClients = clients.filter((client) =>
    client.name.toLowerCase().includes(clientSearch.toLowerCase().trim())
  );

  const clientTrainings = selectedClient
    ? trainings
        .filter((training) => training.clientId === selectedClient.id)
        .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))
    : [];
  const weightProgress = selectedClient
    ? selectedClient.startWeight - selectedClient.weight
    : 0;
  const selectedWeightHistory = selectedClient
    ? clientWeightHistory[selectedClient.id] ?? [
        { date: "2026-08-01", weight: selectedClient.startWeight },
        { date: formatDate(new Date()), weight: selectedClient.weight },
      ]
    : [];

  const selectedClientProgress = selectedClient
    ? buildClientProgress(
        selectedClient.id,
        trainings,
        trainingExercises,
        today,
      )
    : {
        completedThisMonth: 0,
        completedTotal: 0,
        latestCompleted: null,
        caloriesThisMonth: null,
        caloriesTotal: null,
        exercises: [],
      };

  const activeDialog = selectedTraining
    ? "training"
    : selectedClient
      ? "client"
      : isAddModalOpen
        ? "add"
        : null;

  function rememberDialogOpener(element: HTMLElement) {
    dialogOpenerRef.current = element;
  }

  function restoreDialogFocus() {
    const opener = dialogOpenerRef.current;
    dialogOpenerRef.current = null;

    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
    });
  }

  function closeAddDialog() {
    setIsAddModalOpen(false);
    restoreDialogFocus();
  }

  function closeClientDialog() {
    setSelectedClient(null);
    restoreDialogFocus();
  }

  function closeTrainingDialog() {
    setSelectedTraining(null);
    restoreDialogFocus();
  }

  useEffect(() => {
    if (!activeDialog) return;

    const dialog =
      activeDialog === "add"
        ? addDialogRef.current
        : activeDialog === "client"
          ? clientDialogRef.current
          : trainingDialogRef.current;

    if (!dialog) return;
    const dialogElement = dialog;

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    requestAnimationFrame(() => {
      const firstFocusable = dialogElement.querySelector<HTMLElement>(focusableSelector);
      (firstFocusable ?? dialogElement).focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (activeDialog === "add") setIsAddModalOpen(false);
        if (activeDialog === "client") setSelectedClient(null);
        if (activeDialog === "training") setSelectedTraining(null);
        restoreDialogFocus();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogElement.querySelectorAll<HTMLElement>(focusableSelector)
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogElement.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogElement.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [activeDialog]);

  function goToPreviousMonth() {
    setCurrentMonth(
      new Date(year, month - 1, 1)
    );
  }

  function goToNextMonth() {
    setCurrentMonth(
      new Date(year, month + 1, 1)
    );
  }

  function goToToday() {
    const now = new Date();

    setCurrentMonth(
      new Date(
        now.getFullYear(),
        now.getMonth(),
        1
      )
    );

    setSelectedDate(now);
    setSelectedTraining(null);
  }

  function addTraining() {
    if (!newClientId) {
      return;
    }

    const client = clients.find(
      (item) =>
        item.id === Number(newClientId)
    );

    if (!client) {
      return;
    }

    const newTraining: Training = {
      id: Date.now(),
      clientId: client.id,
      clientName: client.name,
      date: selectedKey,
      time: newTime,
      type: "Персональная тренировка",
      completed: false,
    };

    setTrainings((current) => [
      ...current,
      newTraining,
    ]);

    closeAddDialog();
  }

  function getExercisesForTraining(trainingId: number) {
    return trainingExercises[trainingId] ?? [
      { id: 1, name: "Новое упражнение", sets: [{ id: 1, weight: 0, reps: 0 }] },
    ];
  }

  function updateExerciseSet(trainingId: number, exerciseId: number, setId: number, field: "weight" | "reps", value: string) {
    const numericValue = Number(value);
    setTrainingExercises((current) => ({
      ...current,
      [trainingId]: getExercisesForTraining(trainingId).map((exercise) =>
        exercise.id === exerciseId
          ? { ...exercise, sets: exercise.sets.map((set) => set.id === setId ? { ...set, [field]: numericValue } : set) }
          : exercise
      ),
    }));
  }

  function addSet(trainingId: number, exerciseId: number) {
    setTrainingExercises((current) => ({
      ...current,
      [trainingId]: getExercisesForTraining(trainingId).map((exercise) =>
        exercise.id === exerciseId
          ? { ...exercise, sets: [...exercise.sets, { id: Date.now(), weight: 0, reps: 0 }] }
          : exercise
      ),
    }));
  }

  function addExercise(trainingId: number) {
    setTrainingExercises((current) => ({
      ...current,
      [trainingId]: [
        ...getExercisesForTraining(trainingId),
        { id: Date.now(), name: "Новое упражнение", sets: [{ id: Date.now() + 1, weight: 0, reps: 0 }] },
      ],
    }));
  }

  function toggleTrainingCompleted(trainingId: number) {
    setTrainings((current) => current.map((training) => training.id === trainingId ? { ...training, completed: !training.completed } : training));
    setSelectedTraining((current) => current && current.id === trainingId ? { ...current, completed: !current.completed } : current);
  }

  function updateTrainingCalories(trainingId: number, value: string) {
    const caloriesBurned = value === "" ? undefined : Number(value);
    if (
      caloriesBurned !== undefined &&
      (!Number.isFinite(caloriesBurned) || caloriesBurned < 0)
    ) {
      return;
    }

    const update = (training: Training): Training => {
      if (training.id !== trainingId) return training;
      if (caloriesBurned === undefined) {
        const withoutCalories = { ...training };
        delete withoutCalories.caloriesBurned;
        return withoutCalories;
      }
      return { ...training, caloriesBurned };
    };

    setTrainings((current) => current.map(update));
    setSelectedTraining((current) => (current ? update(current) : current));
  }

  function deleteTraining(id: number) {
    setTrainings((current) =>
      current.filter(
        (training) =>
          training.id !== id
      )
    );

    closeTrainingDialog();
  }

  return (
    <AppShell
      activeView={activeView}
      hasActiveDialog={activeDialog !== null}
      onViewChange={setActiveView}
    >

      <div
        aria-hidden={activeDialog !== null || undefined}
        inert={activeDialog !== null || undefined}
        className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6 sm:py-6 lg:px-8"
      >

        {/* HEADER */}

        <header className="flex items-center justify-between md:hidden">

          <div>
            <p className="text-xs font-medium text-zinc-500 sm:text-sm">
              Панель тренера
            </p>

            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              TrainerCRM
            </h1>
          </div>

          {activeView === "schedule" && (
          <button
            type="button"
            onClick={goToToday}
            className="min-h-11 rounded-xl bg-violet-600 px-4 py-2 text-xs font-medium text-white active:scale-95 sm:text-sm"
          >
            Сегодня
          </button>
          )}

        </header>

        {activeView === "schedule" && (
          <>
        {/* CALENDAR */}

        <section aria-labelledby="calendar-month-heading" className="mt-4 rounded-2xl bg-white px-1 py-3 shadow-sm ring-1 ring-zinc-200 sm:mt-8 sm:rounded-3xl sm:p-5">

          <div className="flex items-center justify-between">

            <button
              type="button"
              aria-label="Предыдущий месяц"
              onClick={goToPreviousMonth}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-2xl text-zinc-400 active:bg-zinc-100"
            >
              ‹
            </button>

            <div id="calendar-month-heading" aria-live="polite" className="text-base font-semibold sm:text-lg">
              {monthNames[month]} {year}
            </div>

            <button
              type="button"
              aria-label="Следующий месяц"
              onClick={goToNextMonth}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-2xl text-zinc-400 active:bg-zinc-100"
            >
              ›
            </button>

          </div>

          {/* DAYS OF WEEK */}

          <div className="mt-3 grid grid-cols-7">

            {weekDays.map((day) => (
              <div
                key={day}
                className="py-1.5 text-center text-[10px] font-medium text-zinc-400 sm:py-2 sm:text-xs"
              >
                {day}
              </div>
            ))}

          </div>

          {/* CALENDAR DAYS */}

          <div className="grid grid-cols-7 gap-0.5 sm:gap-1">

            {calendarDays.map(
              (date, index) => {

                if (!date) {
                  return (
                    <div
                      key={`empty-${index}`}
                      className="h-11 sm:h-16"
                    />
                  );
                }

                const key =
                  formatDate(date);

                const dayTrainings =
                  trainings.filter(
                    (training) =>
                      training.date === key
                  );

                const trainingCount =
                  dayTrainings.length;

                const hasTraining =
                  trainingCount > 0;

                const isSelected =
                  formatDate(
                    selectedDate
                  ) === key;

                const isToday =
                  isHydrated && formatDate(today) === key;

                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={`${date.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}${trainingCount ? `, ${trainingCount} ${getTrainingWord(trainingCount)}` : ", тренировок нет"}`}
                    aria-pressed={isSelected}
                    aria-current={isToday ? "date" : undefined}
                    onClick={() => {
                      setSelectedDate(date);
                      setSelectedTraining(null);
                    }}
                    className={`relative flex h-11 flex-col items-center justify-center rounded-xl transition active:scale-95 sm:h-16 sm:rounded-2xl ${
                      isSelected
                        ? "bg-zinc-900 text-white"
                        : "hover:bg-zinc-100"
                    }`}
                  >

                    <div
                      className={`text-xs font-semibold sm:text-sm ${
                        isSelected
                          ? "text-white"
                          : "text-zinc-900"
                      }`}
                    >
                      {date.getDate()}
                    </div>

                    {isToday &&
                      !isSelected &&
                      !hasTraining && (
                        <div className="mt-0.5 h-1 w-1 rounded-full bg-zinc-900 sm:mt-1 sm:h-1.5 sm:w-1.5" />
                      )}

                    {hasTraining && (
                      <div
                        className={`mt-0.5 min-w-4 rounded-full px-1 py-0.5 text-[10px] font-semibold leading-none tabular-nums sm:mt-1 ${
                          isSelected
                            ? "bg-white/20 text-white"
                            : "bg-violet-100 text-violet-700"
                        }`}
                      >
                        {trainingCount}
                      </div>
                    )}

                  </button>
                );
              }
            )}

          </div>

        </section>

          </>
        )}

        {/* CLIENTS */}
        {activeView === "clients" && (
        <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 sm:mt-8 sm:rounded-3xl sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs text-zinc-500 sm:text-sm">Быстрый доступ</p>
              <h2 className="mt-1 text-xl font-semibold sm:text-2xl">Клиенты</h2>
            </div>
            <label htmlFor="client-search" className="sr-only">Поиск клиента</label>
            <input
              id="client-search"
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
              placeholder="Поиск клиента..."
              className="min-h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-base outline-none focus:border-violet-500 sm:max-w-xs sm:text-sm"
            />
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {filteredClients.map((client) => {
              const count = trainings.filter((training) => training.clientId === client.id).length;
              return (
                <button
                  key={client.id}
                  onClick={(event) => {
                    rememberDialogOpener(event.currentTarget);
                    setClientDetailSection("overview");
                    setSelectedClient(client);
                  }}
                  className="flex items-center gap-3 rounded-2xl border border-zinc-200 p-3 text-left transition hover:bg-zinc-50 active:scale-[0.99]"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-semibold text-white">
                    {client.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{client.name}</div>
                    <div className="mt-0.5 text-xs text-zinc-500">{count} {getTrainingWord(count)}</div>
                  </div>
                  <div className="text-lg text-zinc-300">→</div>
                </button>
              );
            })}
          </div>
        </section>
        )}

        {/* SCHEDULE HEADER */}

        {activeView === "schedule" && (
          <>

        <div className="mt-6 flex flex-wrap items-end justify-between gap-3 sm:mt-8">

          <div>
            <p className="text-xs text-zinc-500 sm:text-sm">
              Расписание
            </p>

            <h2 className="mt-1 text-xl font-semibold sm:text-2xl">
              {selectedDate.getDate()}{" "}
              {monthNames[
                selectedDate.getMonth()
              ].toLowerCase()}
            </h2>
          </div>

          <div className="flex items-center gap-2">

            <span className="text-xs text-zinc-500 sm:text-sm">
              {selectedTrainings.length}{" "}
              {getTrainingWord(
                selectedTrainings.length
              )}
            </span>

            <button
              onClick={(event) => {
                rememberDialogOpener(event.currentTarget);
                setNewClientId("");
                setNewTime("09:00");
                setIsAddModalOpen(true);
              }}
              className="min-h-11 rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white active:scale-95 sm:px-4 sm:text-sm"
            >
              + Тренировка
            </button>

          </div>

        </div>

        {/* TRAININGS */}

        <section className="mt-3 space-y-2 sm:mt-4 sm:space-y-3">

          {selectedTrainings.length === 0 ? (

            <div className="rounded-2xl bg-white p-7 text-center shadow-sm ring-1 ring-zinc-200 sm:p-8">

              <div className="text-2xl text-zinc-300">
                —
              </div>

              <p className="mt-2 text-sm font-medium">
                Тренировок нет
              </p>

              <p className="mt-1 text-xs text-zinc-500 sm:text-sm">
                Добавьте тренировку
              </p>

            </div>

          ) : (

            selectedTrainings.map(
              (training) => (

                <button
                  key={training.id}
                  onClick={(event) => {
                    rememberDialogOpener(event.currentTarget);
                    setSelectedTraining(training);
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl bg-white p-3 text-left shadow-sm ring-1 ring-zinc-200 active:scale-[0.99] sm:gap-4 sm:p-4"
                >

                  <div className="w-12 shrink-0 text-sm font-semibold sm:w-16 sm:text-lg">
                    {training.time}
                  </div>

                  <div className="h-9 w-px bg-zinc-200 sm:h-10" />

                  <div className="min-w-0 flex-1">

                    <div className="truncate text-sm font-semibold sm:text-base">
                      {training.clientName}
                    </div>

                    <div className="mt-0.5 truncate text-xs text-zinc-500 sm:mt-1 sm:text-sm">
                      {training.type}
                    </div>

                  </div>

                  <div className="text-lg text-zinc-300">
                    →
                  </div>

                </button>

              )
            )

          )}

        </section>

          </>
        )}

      </div>

      {/* ADD TRAINING */}

      {isAddModalOpen && (

        <div className="fixed inset-0 z-50 flex items-end bg-black/40 sm:items-center sm:justify-center sm:px-4">

          <div
            ref={addDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-training-dialog-title"
            tabIndex={-1}
            className="w-full rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6"
          >

            <div className="flex items-center justify-between">

              <div>

                <p className="text-xs text-zinc-500">
                  {selectedDate.getDate()}{" "}
                  {monthNames[
                    selectedDate.getMonth()
                  ].toLowerCase()}
                </p>

                <h2 id="add-training-dialog-title" className="mt-1 text-xl font-semibold">
                  Новая тренировка
                </h2>

              </div>

              <button
                type="button"
                aria-label="Закрыть окно добавления тренировки"
                onClick={closeAddDialog}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-xl text-zinc-400 active:bg-zinc-100"
              >
                ×
              </button>

            </div>

            <div className="mt-5 space-y-4">

              <div>

                <label htmlFor="new-training-client" className="text-xs font-medium text-zinc-700 sm:text-sm">
                  Клиент
                </label>

                <select
                  id="new-training-client"
                  value={newClientId}
                  onChange={(event) =>
                    setNewClientId(
                      event.target.value
                    )
                  }
                  className="mt-2 w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm outline-none focus:border-zinc-500"
                >

                  <option value="">
                    Выберите клиента
                  </option>

                  {clients.map(
                    (client) => (
                      <option
                        key={client.id}
                        value={client.id}
                      >
                        {client.name}
                      </option>
                    )
                  )}

                </select>

              </div>

              <div>

                <span className="text-xs font-medium text-zinc-700 sm:text-sm">
                  Время
                </span>

                <div className="mt-2 grid grid-cols-2 gap-2">
  <select
    aria-label="Часы начала тренировки"
    value={newTime.split(":")[0]}
    onChange={(event) =>
      setNewTime(`${event.target.value}:${newTime.split(":")[1] || "00"}`)
    }
    className="w-full rounded-xl border border-zinc-200 px-3 py-3 text-sm outline-none focus:border-zinc-500"
  >
    {Array.from({ length: 24 }, (_, hour) => {
      const value = String(hour).padStart(2, "0");

      return (
        <option key={value} value={value}>
          {value}
        </option>
      );
    })}
  </select>

  <select
    aria-label="Минуты начала тренировки"
    value={newTime.split(":")[1] || "00"}
    onChange={(event) =>
      setNewTime(`${newTime.split(":")[0] || "09"}:${event.target.value}`)
    }
    className="w-full rounded-xl border border-zinc-200 px-3 py-3 text-sm outline-none focus:border-zinc-500"
  >
    {["00", "10", "20", "30", "40", "50"].map((minute) => (
      <option key={minute} value={minute}>
        {minute}
      </option>
    ))}
  </select>
</div>

              </div>

            </div>

            <div className="mt-6 flex gap-2">

              <button
                type="button"
                onClick={closeAddDialog}
                className="flex-1 rounded-xl border border-zinc-200 px-3 py-3 text-sm font-medium active:bg-zinc-50"
              >
                Отмена
              </button>

              <button
                type="button"
                onClick={addTraining}
                disabled={!newClientId}
                className="flex-1 rounded-xl bg-zinc-900 px-3 py-3 text-sm font-medium text-white active:bg-zinc-700 disabled:opacity-40"
              >
                Добавить
              </button>

            </div>

          </div>

        </div>

      )}

      {/* TRAINING DETAILS */}

      {selectedClient && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-0 sm:p-6">
          <div
            ref={clientDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="client-dialog-title"
            tabIndex={-1}
            className="mx-auto min-h-full w-full bg-white pb-[env(safe-area-inset-bottom)] sm:min-h-0 sm:max-w-3xl sm:rounded-3xl sm:pb-0 sm:shadow-2xl"
          >
            <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white px-4 py-4 sm:rounded-t-3xl sm:px-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-zinc-500">Карточка клиента</p>
                  <h2 id="client-dialog-title" className="mt-1 text-2xl font-semibold">{selectedClient.name}</h2>
                </div>
                <button type="button" aria-label="Закрыть карточку клиента" onClick={closeClientDialog} className="flex h-11 w-11 items-center justify-center rounded-xl text-xl text-zinc-400 active:bg-zinc-100">×</button>
              </div>
            </div>

            <div className="p-4 sm:p-6">
              <div className="grid grid-cols-3 gap-1 rounded-2xl bg-zinc-100 p-1" aria-label="Разделы карточки клиента">
                {([
                  ["overview", "Обзор"],
                  ["trainings", "Тренировки"],
                  ["progress", "Прогресс"],
                ] as const).map(([section, label]) => (
                  <button
                    key={section}
                    type="button"
                    aria-pressed={clientDetailSection === section}
                    onClick={() => setClientDetailSection(section)}
                    className={`min-h-11 rounded-xl px-2 py-2 text-xs font-medium transition-colors sm:text-sm ${
                      clientDetailSection === section
                        ? "bg-white text-violet-700 shadow-sm"
                        : "text-zinc-600 hover:text-zinc-950"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {clientDetailSection === "overview" && (
              <section className="mt-5" aria-labelledby="client-overview-heading">
                <h3 id="client-overview-heading" className="sr-only">Обзор клиента</h3>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                <div className="rounded-2xl bg-zinc-50 p-4"><div className="text-xs text-zinc-500">Завершено в этом месяце</div><div className="mt-1 text-2xl font-semibold">{selectedClientProgress.completedThisMonth}</div></div>
                <div className="rounded-2xl bg-zinc-50 p-4"><div className="text-xs text-zinc-500">Завершено всего</div><div className="mt-1 text-2xl font-semibold">{selectedClientProgress.completedTotal}</div></div>
                <div className="rounded-2xl bg-zinc-50 p-4">
                  <div className="text-xs text-zinc-500">Последняя завершённая</div>

                  {selectedClientProgress.latestCompleted ? (
                    <>
                      <div className="mt-1 text-lg font-semibold">{formatShortDate(selectedClientProgress.latestCompleted.date)} · {selectedClientProgress.latestCompleted.time}</div>
                      <div className="mt-1 text-xs text-zinc-500">{selectedClientProgress.latestCompleted.type}</div>
                    </>
                  ) : (
                    <div className="mt-1 text-sm font-medium text-zinc-500">Пока нет</div>
                  )}
                </div>
              <div className="rounded-2xl bg-zinc-50 p-4">
  <div className="text-xs text-zinc-500">Текущий вес</div>
  <div className="mt-1 text-2xl font-semibold">
    {selectedClient.weight} кг
  </div>
</div>

<div className="rounded-2xl bg-zinc-50 p-4">
  <div className="text-xs text-zinc-500">Изменение веса</div>
  <div className="mt-1 text-2xl font-semibold">
    {weightProgress > 0 ? "-" : "+"}
    {Math.abs(weightProgress).toFixed(1)} кг
  </div>
</div>
              </div>
              </section>
              )}

              {clientDetailSection === "progress" && (
              <div>
              <ClientProgressSection
                key={selectedClient.id}
                progress={selectedClientProgress}
              />

              <section className="mt-5 rounded-2xl border border-zinc-200 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs text-zinc-500">Прогресс веса</p>
                    <h3 className="mt-1 font-semibold">Изменение по датам</h3>
                  </div>
                  <div className="text-sm font-semibold">{selectedClient.startWeight} → {selectedClient.weight} кг</div>
                </div>

                <div className="mt-4 rounded-2xl bg-zinc-50 p-3">
                  <div className="relative h-40">
                    <svg viewBox="0 0 640 180" className="h-full w-full" preserveAspectRatio="none" role="img" aria-label="График изменения веса">
                      {selectedWeightHistory.length > 1 && (() => {
                        const values = selectedWeightHistory.map((point) => point.weight);
                        const min = Math.min(...values);
                        const max = Math.max(...values);
                        const range = Math.max(max - min, 1);
                        const points = selectedWeightHistory.map((point, index) => {
                          const x = (index / (selectedWeightHistory.length - 1)) * 600 + 20;
                          const y = 150 - ((point.weight - min) / range) * 110;
                          return `${x},${y}`;
                        }).join(" ");
                        return (
                          <>
                            <line x1="20" y1="150" x2="620" y2="150" stroke="currentColor" className="text-zinc-200" />
                            <polyline fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-900" points={points} />
                            {selectedWeightHistory.map((point, index) => {
                              const x = (index / (selectedWeightHistory.length - 1)) * 600 + 20;
                              const y = 150 - ((point.weight - min) / range) * 110;
                              return <circle key={`${point.date}-${index}`} cx={x} cy={y} r="5" fill="currentColor" className="text-zinc-900" />;
                            })}
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                  <div className="mt-2 flex justify-between gap-2 text-[10px] text-zinc-400">
                    {selectedWeightHistory.map((point) => <span key={point.date}>{formatShortDate(point.date)}</span>)}
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {selectedWeightHistory.map((point) => (
                    <div key={point.date} className="flex items-center justify-between rounded-xl border border-zinc-100 px-3 py-2 text-sm">
                      <span className="text-zinc-500">{formatShortDate(point.date)}</span>
                      <span className="font-semibold">{point.weight} кг</span>
                    </div>
                  ))}
                </div>
              </section>
              </div>
              )}

              {clientDetailSection === "trainings" && (
              <section className="mt-5">
                <p className="text-xs text-zinc-500">История</p>
                <h3 className="mt-1 text-lg font-semibold">Тренировки клиента</h3>
                <div className="mt-3 space-y-2">
                  {clientTrainings.map((training) => (
                    <button
                      key={training.id}
                      onClick={() => {
                        setSelectedClient(null);
                        setSelectedTraining(training);
                      }}
                      className="flex w-full items-center gap-3 rounded-2xl border border-zinc-200 p-3 text-left hover:bg-zinc-50"
                    >
                      <div className="w-20 shrink-0"><div className="text-sm font-semibold">{training.date.slice(8, 10)}.{training.date.slice(5, 7)}</div><div className="text-xs text-zinc-500">{training.time}</div></div>
                      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{training.type}</div><div className="text-xs text-zinc-500">Открыть тренировку</div></div>
                      <div className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-semibold">Открыть</div>
                    </button>
                  ))}
                  {clientTrainings.length === 0 && (
                    <p className="rounded-2xl bg-zinc-50 p-4 text-sm text-zinc-500">
                      У клиента пока нет тренировок.
                    </p>
                  )}
                </div>
              </section>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedTraining && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/40 sm:items-center sm:justify-center sm:px-4">
          <div
            ref={trainingDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="training-dialog-title"
            tabIndex={-1}
            className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-3xl sm:rounded-3xl sm:p-6"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-zinc-500">Тренировка</p>
                <h2 id="training-dialog-title" className="mt-1 text-xl font-semibold">{selectedTraining.clientName}</h2>
                <p className="mt-1 text-sm text-zinc-500">{selectedTraining.date} · {selectedTraining.time}</p>
              </div>
              <button type="button" aria-label="Закрыть карточку тренировки" onClick={closeTrainingDialog} className="flex h-11 w-11 items-center justify-center rounded-xl text-xl text-zinc-400 active:bg-zinc-100">×</button>
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className={`inline-flex w-fit items-center rounded-full px-3 py-1.5 text-xs font-semibold ${selectedTraining.completed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                {selectedTraining.completed ? "✓ Тренировка завершена" : "○ Тренировка не завершена"}
              </div>
              <button onClick={() => toggleTrainingCompleted(selectedTraining.id)} className="min-h-11 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white active:bg-zinc-700">
                {selectedTraining.completed ? "Отметить как незавершённую" : "Завершить тренировку"}
              </button>
            </div>

            <div className="mt-4 max-w-xs">
              <label
                htmlFor="training-calories-burned"
                className="block text-xs font-medium text-zinc-600"
              >
                Сожжённые калории (необязательно)
              </label>
              <div className="relative mt-2">
                <input
                  id="training-calories-burned"
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={selectedTraining.caloriesBurned ?? ""}
                  onChange={(event) =>
                    updateTrainingCalories(selectedTraining.id, event.target.value)
                  }
                  placeholder="Не указаны"
                  className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 pr-14 text-sm outline-none focus:border-zinc-400"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-zinc-400">
                  ккал
                </span>
              </div>
            </div>

            <section className="mt-5">
              <div className="flex items-end justify-between gap-3">
                <div><p className="text-xs text-zinc-500">Содержание</p><h3 className="mt-1 text-lg font-semibold">Упражнения и веса</h3></div>
                <button onClick={() => addExercise(selectedTraining.id)} className="min-h-11 rounded-xl border border-zinc-200 px-3 py-2 text-xs font-medium hover:bg-zinc-50">+ Упражнение</button>
              </div>

              <div className="mt-4 space-y-3">
                {getExercisesForTraining(selectedTraining.id).map((exercise) => (
                  <div key={exercise.id} className="rounded-2xl border border-zinc-200 p-4">
                    <div className="flex items-center justify-between gap-3"><div className="font-semibold">{exercise.name}</div><span className="text-xs text-zinc-400">{exercise.sets.length} {exercise.sets.length === 1 ? "подход" : exercise.sets.length < 5 ? "подхода" : "подходов"}</span></div>
                    <div className="mt-3 grid grid-cols-[40px_1fr_1fr] gap-2 text-xs text-zinc-500"><div>№</div><div>Вес, кг</div><div>Повторы</div></div>
                    <div className="mt-1 space-y-2">
                      {exercise.sets.map((set, index) => (
                        <div key={set.id} className="grid grid-cols-[40px_1fr_1fr] items-center gap-2">
                          <div className="text-sm font-medium text-zinc-500">{index + 1}</div>
                          <input type="number" min="0" step="0.5" value={set.weight} onChange={(event) => updateExerciseSet(selectedTraining.id, exercise.id, set.id, "weight", event.target.value)} className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm outline-none focus:border-zinc-400" />
                          <input type="number" min="0" value={set.reps} onChange={(event) => updateExerciseSet(selectedTraining.id, exercise.id, set.id, "reps", event.target.value)} className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm outline-none focus:border-zinc-400" />
                        </div>
                      ))}
                    </div>
                    <button onClick={() => addSet(selectedTraining.id, exercise.id)} className="mt-3 min-h-11 rounded-lg px-2 text-xs font-medium text-zinc-600 hover:text-zinc-900">+ Добавить подход</button>
                  </div>
                ))}
              </div>
            </section>

            <div className="mt-6 flex gap-2">
              <button onClick={closeTrainingDialog} className="min-h-11 flex-1 rounded-xl border border-zinc-200 px-3 py-3 text-sm font-medium active:bg-zinc-50">Закрыть</button>
              <button onClick={() => deleteTraining(selectedTraining.id)} className="min-h-11 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600 active:bg-red-100">Удалить</button>
            </div>
          </div>
        </div>
      )}

    </AppShell>
  );
}
