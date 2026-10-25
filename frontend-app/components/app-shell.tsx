"use client";

import type { ReactNode } from "react";

export type AppView = "schedule" | "clients";

type AppShellProps = {
  activeView: AppView;
  children: ReactNode;
  hasActiveDialog?: boolean;
  onViewChange: (view: AppView) => void;
};

const destinations: { id: AppView; label: string; icon: string }[] = [
  { id: "schedule", label: "Расписание", icon: "▦" },
  { id: "clients", label: "Клиенты", icon: "●" },
];

function Navigation({
  activeView,
  onViewChange,
}: Pick<AppShellProps, "activeView" | "onViewChange">) {
  return (
    <nav aria-label="Основная навигация" className="flex gap-2 md:flex-col">
      {destinations.map((destination) => {
        const isActive = activeView === destination.id;

        return (
          <button
            key={destination.id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onViewChange(destination.id)}
            className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
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
        </aside>

        <main className="min-w-0 flex-1 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </main>
      </div>

      <div
        aria-hidden={hasActiveDialog || undefined}
        inert={hasActiveDialog || undefined}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200 bg-white/95 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(24,24,27,0.08)] backdrop-blur md:hidden"
      >
        <Navigation activeView={activeView} onViewChange={onViewChange} />
      </div>
    </div>
  );
}
