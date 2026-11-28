"use client";

import type { ReactNode } from "react";

export type AppView = "schedule" | "clients" | "workouts";

type AppShellProps = {
  activeView: AppView;
  children: ReactNode;
  hasActiveDialog?: boolean;
  isLoggingOut?: boolean;
  onLogout?: () => void;
  onViewChange: (view: AppView) => void;
};

const destinations: { id: AppView; label: string; icon: string }[] = [
  { id: "schedule", label: "Расписание", icon: "▦" },
  { id: "clients", label: "Клиенты", icon: "●" },
  { id: "workouts", label: "Тренировки", icon: "◆" },
];

function Navigation({
  activeView,
  onViewChange,
}: Pick<AppShellProps, "activeView" | "onViewChange">) {
  return (
    <nav aria-label="Основная навигация" className="grid grid-cols-3 gap-1 md:flex md:flex-col md:gap-2">
      {destinations.map((destination) => {
        const isActive = activeView === destination.id;

        return (
          <button
            key={destination.id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onViewChange(destination.id)}
            className={`flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-xl px-1 py-2 text-xs font-medium transition-colors md:flex-row md:gap-2 md:px-4 md:py-2.5 md:text-sm ${
              isActive
                ? "bg-violet-600 text-white shadow-sm"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
            }`}
          >
            <span aria-hidden="true" className="text-base">
              {destination.icon}
            </span>
            {destination.label}
          </button>
        );
      })}
    </nav>
  );
}

export function AppShell({
  activeView,
  children,
  hasActiveDialog = false,
  isLoggingOut = false,
  onLogout,
  onViewChange,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl">
        <aside
          aria-hidden={hasActiveDialog || undefined}
          inert={hasActiveDialog || undefined}
          className="hidden w-56 shrink-0 border-r border-zinc-200 bg-white px-4 py-6 md:block"
        >
          <p className="px-2 text-xs font-medium uppercase tracking-[0.16em] text-violet-600">
            Панель тренера
          </p>
          <p className="mt-1 px-2 text-xl font-semibold tracking-tight">
            TrainerCRM
          </p>
          <div className="mt-8">
            <Navigation activeView={activeView} onViewChange={onViewChange} />
          </div>
          {onLogout && (
            <button type="button" disabled={isLoggingOut} onClick={onLogout} className="mt-8 min-h-11 w-full rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">
              {isLoggingOut ? "Выходим…" : "Выйти"}
            </button>
          )}
        </aside>

        <main className="min-w-0 flex-1 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-0">
          {onLogout && (
            <header
              aria-hidden={hasActiveDialog || undefined}
              inert={hasActiveDialog || undefined}
              className="flex items-center justify-between border-b border-zinc-200 bg-white px-3 py-1.5 md:hidden"
            >
              <span className="text-sm font-semibold tracking-tight">
                TrainerCRM
              </span>
              <button
                type="button"
                aria-label={isLoggingOut ? "Выходим…" : "Выйти"}
                title="Выйти"
                aria-busy={isLoggingOut}
                disabled={isLoggingOut}
                onClick={onLogout}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-violet-600 disabled:opacity-50"
              >
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 17l5-5-5-5" />
                  <path d="M15 12H3" />
                  <path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" />
                </svg>
              </button>
            </header>
          )}
          {children}
        </main>
      </div>

      <div
        aria-hidden={hasActiveDialog || undefined}
        inert={hasActiveDialog || undefined}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(24,24,27,0.08)] backdrop-blur md:hidden"
      >
        <Navigation
          activeView={activeView}
          onViewChange={onViewChange}
        />
      </div>
    </div>
  );
}
