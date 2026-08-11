"use client";

import { useState } from "react";

type Client = {
  id: number;
  name: string;
};

type Training = {
  id: number;
  clientId: number;
  clientName: string;
  date: string;
  time: string;
  type: string;
};

const clients: Client[] = [
  { id: 1, name: "Анна Петрова" },
  { id: 2, name: "Сергей Иванов" },
  { id: 3, name: "Мария Смирнова" },
  { id: 4, name: "Алексей Волков" },
  { id: 5, name: "Елена Кузнецова" },
  { id: 6, name: "Дмитрий Орлов" },
  { id: 7, name: "Ольга Морозова" },
  { id: 8, name: "Иван Соколов" },
];

const initialTrainings: Training[] = [
  {
    id: 1,
    clientId: 1,
    clientName: "Анна Петрова",
    date: "2026-08-11",
    time: "09:00",
    type: "Персональная тренировка",
  },
  {
    id: 2,
    clientId: 2,
    clientName: "Сергей Иванов",
    date: "2026-08-11",
    time: "11:00",
    type: "Персональная тренировка",
  },
  {
    id: 3,
    clientId: 3,
    clientName: "Мария Смирнова",
    date: "2026-08-13",
    time: "09:00",
    type: "Персональная тренировка",
  },
  {
    id: 4,
    clientId: 4,
    clientName: "Алексей Волков",
    date: "2026-08-13",
    time: "09:00",
    type: "Персональная тренировка",
  },
  {
    id: 5,
    clientId: 5,
    clientName: "Елена Кузнецова",
    date: "2026-08-13",
    time: "09:00",
    type: "Персональная тренировка",
  },
  {
    id: 6,
    clientId: 6,
    clientName: "Дмитрий Орлов",
    date: "2026-08-13",
    time: "18:00",
    type: "Персональная тренировка",
  },
  {
    id: 7,
    clientId: 7,
    clientName: "Ольга Морозова",
    date: "2026-08-15",
    time: "10:00",
    type: "Персональная тренировка",
  },
  {
    id: 8,
    clientId: 8,
    clientName: "Иван Соколов",
    date: "2026-08-15",
    time: "12:00",
    type: "Персональная тренировка",
  },
  {
    id: 9,
    clientId: 1,
    clientName: "Анна Петрова",
    date: "2026-08-18",
    time: "09:00",
    type: "Персональная тренировка",
  },
  {
    id: 10,
    clientId: 2,
    clientName: "Сергей Иванов",
    date: "2026-08-20",
    time: "17:00",
    type: "Персональная тренировка",
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

export default function Home() {
  const today = new Date();

  const [currentMonth, setCurrentMonth] = useState(
    new Date(today.getFullYear(), today.getMonth(), 1)
  );

  const [selectedDate, setSelectedDate] = useState(today);

  const [trainings, setTrainings] =
    useState<Training[]>(initialTrainings);

  const [selectedTraining, setSelectedTraining] =
    useState<Training | null>(null);

  const [isAddModalOpen, setIsAddModalOpen] =
    useState(false);

  const [newClientId, setNewClientId] =
    useState("");

  const [newTime, setNewTime] =
    useState("09:00");

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
    };

    setTrainings((current) => [
      ...current,
      newTraining,
    ]);

    setIsAddModalOpen(false);
  }

  function deleteTraining(id: number) {
    setTrainings((current) =>
      current.filter(
        (training) =>
          training.id !== id
      )
    );

    setSelectedTraining(null);
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-900">

      <div className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6 sm:py-6">

        {/* HEADER */}

        <header className="flex items-center justify-between">

          <div>
            <p className="text-xs font-medium text-zinc-500 sm:text-sm">
              Панель тренера
            </p>

            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              TrainerCRM
            </h1>
          </div>

          <button
            onClick={goToToday}
            className="rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white active:scale-95 sm:px-4 sm:text-sm"
          >
            Сегодня
          </button>

        </header>

        {/* CALENDAR */}

        <section className="mt-4 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-zinc-200 sm:mt-8 sm:rounded-3xl sm:p-5">

          <div className="flex items-center justify-between">

            <button
              onClick={goToPreviousMonth}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-2xl text-zinc-400 active:bg-zinc-100 sm:h-11 sm:w-11"
            >
              ‹
            </button>

            <div className="text-base font-semibold sm:text-lg">
              {monthNames[month]} {year}
            </div>

            <button
              onClick={goToNextMonth}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-2xl text-zinc-400 active:bg-zinc-100 sm:h-11 sm:w-11"
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

          <div className="grid grid-cols-7 gap-1">

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
                  formatDate(today) === key;

                return (
                  <button
                    key={key}
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
                        className={`mt-0.5 text-[9px] font-semibold leading-none sm:mt-1 sm:text-[10px] ${
                          isSelected
                            ? "text-white"
                            : "text-zinc-500"
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

        {/* SCHEDULE HEADER */}

        <div className="mt-6 flex items-end justify-between sm:mt-8">

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
              onClick={() => {
                setNewClientId("");
                setNewTime("09:00");
                setIsAddModalOpen(true);
              }}
              className="rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white active:scale-95 sm:px-4 sm:text-sm"
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
                  onClick={() =>
                    setSelectedTraining(
                      training
                    )
                  }
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

      </div>

      {/* ADD TRAINING */}

      {isAddModalOpen && (

        <div className="fixed inset-0 z-50 flex items-end bg-black/40 sm:items-center sm:justify-center sm:px-4">

          <div className="w-full rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">

            <div className="flex items-center justify-between">

              <div>

                <p className="text-xs text-zinc-500">
                  {selectedDate.getDate()}{" "}
                  {monthNames[
                    selectedDate.getMonth()
                  ].toLowerCase()}
                </p>

                <h2 className="mt-1 text-xl font-semibold">
                  Новая тренировка
                </h2>

              </div>

              <button
                onClick={() =>
                  setIsAddModalOpen(false)
                }
                className="flex h-10 w-10 items-center justify-center rounded-xl text-xl text-zinc-400 active:bg-zinc-100"
              >
                ×
              </button>

            </div>

            <div className="mt-5 space-y-4">

              <div>

                <label className="text-xs font-medium text-zinc-700 sm:text-sm">
                  Клиент
                </label>

                <select
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

                <label className="text-xs font-medium text-zinc-700 sm:text-sm">
                  Время
                </label>

                <input
                  type="time"
                  value={newTime}
                  onChange={(event) =>
                    setNewTime(
                      event.target.value
                    )
                  }
                  className="mt-2 w-full rounded-xl border border-zinc-200 px-3 py-3 text-sm outline-none focus:border-zinc-500"
                />

              </div>

            </div>

            <div className="mt-6 flex gap-2">

              <button
                onClick={() =>
                  setIsAddModalOpen(false)
                }
                className="flex-1 rounded-xl border border-zinc-200 px-3 py-3 text-sm font-medium active:bg-zinc-50"
              >
                Отмена
              </button>

              <button
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

      {selectedTraining && (

        <div className="fixed inset-0 z-50 flex items-end bg-black/40 sm:items-center sm:justify-center sm:px-4">

          <div className="w-full rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">

            <div className="flex items-start justify-between">

              <div>

                <p className="text-xs text-zinc-500">
                  Тренировка
                </p>

                <h2 className="mt-1 text-xl font-semibold">
                  {selectedTraining.clientName}
                </h2>

              </div>

              <button
                onClick={() =>
                  setSelectedTraining(null)
                }
                className="flex h-10 w-10 items-center justify-center rounded-xl text-xl text-zinc-400 active:bg-zinc-100"
              >
                ×
              </button>

            </div>

            <div className="mt-5 grid grid-cols-2 gap-2">

              <div className="rounded-2xl bg-zinc-50 p-3">

                <div className="text-[10px] text-zinc-500 sm:text-xs">
                  Дата
                </div>

                <div className="mt-1 text-sm font-medium">
                  {selectedTraining.date}
                </div>

              </div>

              <div className="rounded-2xl bg-zinc-50 p-3">

                <div className="text-[10px] text-zinc-500 sm:text-xs">
                  Время
                </div>

                <div className="mt-1 text-sm font-medium">
                  {selectedTraining.time}
                </div>

              </div>

            </div>

            <div className="mt-2 rounded-2xl bg-zinc-50 p-3">

              <div className="text-[10px] text-zinc-500 sm:text-xs">
                Тип
              </div>

              <div className="mt-1 text-sm font-medium">
                {selectedTraining.type}
              </div>

            </div>

            <div className="mt-6 flex gap-2">

              <button
                onClick={() =>
                  setSelectedTraining(null)
                }
                className="flex-1 rounded-xl border border-zinc-200 px-3 py-3 text-sm font-medium active:bg-zinc-50"
              >
                Закрыть
              </button>

              <button
                onClick={() =>
                  deleteTraining(
                    selectedTraining.id
                  )
                }
                className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-600 active:bg-red-100"
              >
                Удалить
              </button>

            </div>

          </div>

        </div>

      )}

    </main>
  );
}