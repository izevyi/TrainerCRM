"use client";

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { login, logout, verifySession, type TrainerSession } from "../lib/auth/client-auth";

type AuthState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; trainer: TrainerSession };

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

export function AuthGate({ children }: { children: (logoutAction: () => void, isLoggingOut: boolean) => ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void verifySession().then((result) => {
      if (!active) return;
      setAuth(result.ok ? { status: "authenticated", trainer: result.trainer } : { status: "anonymous" });
      if (!result.ok && result.kind === "unavailable") {
        setErrors({ form: "Не удалось проверить вход. Проверьте подключение и попробуйте ещё раз." });
      }
    });
    return () => { active = false; };
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
    if (submittingRef.current) return;
    const validation = validate(email, password);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    setErrors({});
    const result = await login(email.trim(), password);
    setPassword("");
    submittingRef.current = false;
    setIsSubmitting(false);
    if (result.ok) {
      setAuth({ status: "authenticated", trainer: result.trainer });
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
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    const completed = await logout();
    setIsLoggingOut(false);
    setAuth({ status: "anonymous" });
    if (!completed) {
      setErrors({ form: "Сеанс завершён в этом окне. Сервер не подтвердил выход — проверьте подключение." });
    }
  }

  if (auth.status === "checking") {
    return (
      <main className="auth-page" aria-busy="true">
        <div className="auth-loader" role="status"><span className="auth-spinner" aria-hidden="true" />Проверяем сеанс…</div>
      </main>
    );
  }

  if (auth.status === "authenticated") return <>{children(logoutAction, isLoggingOut)}</>;

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
