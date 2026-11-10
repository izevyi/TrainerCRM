"use client";

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { login, logout, verifySession, type TrainerSession } from "../lib/auth/client-auth";

type AuthState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; trainer: TrainerSession; generation: number };

type Errors = { email?: string; password?: string; form?: string };

function validate(email: string, password: string): Errors {
  const errors: Errors = {};
  const normalizedEmail = email.trim();
  if (!normalizedEmail) errors.email = "Введите электронную почту.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    errors.email = "Введите корректный адрес электронной почты.";
  }
  if (!password) errors.password = "Введите пароль.";
  return errors;
}

export function AuthGate({ children }: { children: (logoutAction: () => void, isLoggingOut: boolean, trainer: TrainerSession, authenticationFailed: () => void) => ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const loggingOutRef = useRef(false);
  const mountedRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const trainerIdRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const generation = ++sessionGenerationRef.current;
    let active = true;
    void verifySession().then((result) => {
      if (!active || !mountedRef.current || sessionGenerationRef.current !== generation) return;
      trainerIdRef.current = result.ok ? result.trainer.trainerId : null;
      setAuth(result.ok ? { status: "authenticated", trainer: result.trainer, generation } : { status: "anonymous" });
      if (!result.ok && result.kind === "unavailable") {
        setErrors({ form: "Не удалось проверить вход. Проверьте подключение и попробуйте ещё раз." });
      }
    });
    return () => {
      active = false;
      mountedRef.current = false;
      trainerIdRef.current = null;
      sessionGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    const expiresAt = Math.min(
      new Date(auth.trainer.idleExpiresAt).getTime(),
      new Date(auth.trainer.absoluteExpiresAt).getTime(),
    );
    if (!Number.isFinite(expiresAt)) return;
    const expire = () => {
      setAuth({ status: "anonymous" });
      setErrors({ form: "Сеанс истёк. Войдите снова." });
    };
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [auth]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || loggingOutRef.current) return;
    const validation = validate(email, password);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }

    submittingRef.current = true;
    const generation = ++sessionGenerationRef.current;
    setIsSubmitting(true);
    setErrors({});
    const result = await login(email.trim(), password);
    if (!mountedRef.current || sessionGenerationRef.current !== generation) return;
    setPassword("");
    submittingRef.current = false;
    setIsSubmitting(false);
    if (result.ok) {
      trainerIdRef.current = result.trainer.trainerId;
      setAuth({ status: "authenticated", trainer: result.trainer, generation });
      return;
    }
    const form = result.kind === "unauthorized"
      ? "Неверная электронная почта или пароль."
      : result.kind === "rate-limited"
        ? "Слишком много попыток входа. Подождите минуту и попробуйте снова."
        : "Сервис входа сейчас недоступен. Проверьте подключение и попробуйте позже.";
    setErrors({ form });
  }

  async function logoutAction() {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    const generation = ++sessionGenerationRef.current;
    setIsLoggingOut(true);
    setLogoutError(null);
    const completed = await logout();
    if (!mountedRef.current || !loggingOutRef.current) return;
    loggingOutRef.current = false;
    setIsLoggingOut(false);
    if (sessionGenerationRef.current !== generation) return;
    if (completed) {
      trainerIdRef.current = null;
      setAuth({ status: "anonymous" });
      return;
    }
    setLogoutError("Сервер не подтвердил выход. Состояние сеанса неизвестно — проверьте подключение и попробуйте выйти снова.");
  }

  function authenticationFailed(expectedTrainerId: string, expectedGeneration: number) {
    setAuth((current) => {
      if (current.status !== "authenticated" || current.generation !== expectedGeneration || current.trainer.trainerId !== expectedTrainerId) return current;
      sessionGenerationRef.current += 1;
      trainerIdRef.current = null;
      setErrors({ form: "Сеанс истёк. Войдите снова." });
      return { status: "anonymous" };
    });
  }

  if (auth.status === "checking") {
    return (
      <main className="auth-page" aria-busy="true">
        <div className="auth-loader" role="status"><span className="auth-spinner" aria-hidden="true" />Проверяем сеанс…</div>
      </main>
    );
  }

  if (auth.status === "anonymous" && isLoggingOut) {
    return (
      <main className="auth-page" aria-busy="true">
        <div className="auth-loader" role="status"><span className="auth-spinner" aria-hidden="true" />Завершаем сеанс…</div>
      </main>
    );
  }

  if (auth.status === "authenticated") {
    const generation = auth.generation;
    const trainerId = auth.trainer.trainerId;
    return <>
      {logoutError && <div className="mx-auto mt-4 w-[calc(100%-2rem)] max-w-5xl rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">{logoutError}</div>}
      {/* The callbacks intentionally read mutable request/session refs only when invoked. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {children(logoutAction, isLoggingOut, auth.trainer, () => authenticationFailed(trainerId, generation))}
    </>;
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-heading">
        <div className="auth-brand" aria-hidden="true">T</div>
        <p className="auth-eyebrow">Панель тренера</p>
        <h1 id="login-heading">Вход в TrainerCRM</h1>
        <p className="auth-intro">Войдите, чтобы продолжить работу с расписанием и клиентами.</p>
        <form className="auth-form" noValidate onSubmit={submit}>
          <div>
            <label htmlFor="login-email">Электронная почта</label>
            <input id="login-email" name="email" type="email" inputMode="email" autoComplete="username" maxLength={254} autoFocus value={email} disabled={isSubmitting} aria-invalid={!!errors.email} aria-describedby={errors.email ? "login-email-error" : undefined} onChange={(event) => { setEmail(event.target.value); setErrors((current) => ({ ...current, email: undefined, form: undefined })); }} />
            {errors.email && <p id="login-email-error" className="auth-field-error">{errors.email}</p>}
          </div>
          <div>
            <label htmlFor="login-password">Пароль</label>
            <input id="login-password" name="password" type="password" autoComplete="current-password" maxLength={1024} value={password} disabled={isSubmitting} aria-invalid={!!errors.password} aria-describedby={errors.password ? "login-password-error" : undefined} onChange={(event) => { setPassword(event.target.value); setErrors((current) => ({ ...current, password: undefined, form: undefined })); }} />
            {errors.password && <p id="login-password-error" className="auth-field-error">{errors.password}</p>}
          </div>
          {errors.form && <p className="auth-form-error" role="alert">{errors.form}</p>}
          <button type="submit" disabled={isSubmitting}>{isSubmitting ? "Входим…" : "Войти"}</button>
        </form>
      </section>
    </main>
  );
}
