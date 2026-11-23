"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

type Props = { onBack: () => void; verificationToken: string | null };
type Stage = "form" | "sending" | "sent" | "verifying" | "verified" | "error";

export function TrainerRegistration({ onBack, verificationToken }: Props) {
  const [stage, setStage] = useState<Stage>(verificationToken ? "verifying" : "form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [message, setMessage] = useState("");
  const submitting = useRef(false);

  useEffect(() => {
    if (!verificationToken) return;
    let active = true;
    void fetch("/api/auth/verify-registration", {
      method:"POST", credentials:"same-origin", cache:"no-store",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ token:verificationToken }),
    }).then((response) => {
      if (!active) return;
      if (response.ok) setStage("verified");
      else { setStage("error"); setMessage(response.status===400 ?
        "Ссылка недействительна или срок её действия истёк. Зарегистрируйтесь ещё раз." :
        "Не удалось подтвердить почту. Попробуйте ещё раз позже."); }
    }).catch(() => {
      if (active) { setStage("error"); setMessage("Нет соединения с сервером. Попробуйте повторить регистрацию позже."); }
    });
    return () => { active=false; };
  }, [verificationToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (Array.from(password).length<8 || password!==repeat) {
      setMessage("Пароль должен содержать минимум 8 символов, оба пароля должны совпадать.");
      return;
    }
    submitting.current=true;
    setMessage(""); setStage("sending");
    try {
      const response = await fetch("/api/auth/register", {
        method:"POST", credentials:"same-origin", cache:"no-store",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ email, password }),
      });
      if (response.status===202) {
        setStage("sent"); setPassword(""); setRepeat("");
      } else {
        setStage("form");
        setMessage(response.status===429 ? "Слишком много запросов. Повторите через минуту." :
          response.status===400 ? "Проверьте email и пароль (минимум 8 символов)." :
          "Регистрация временно недоступна. Попробуйте позже.");
      }
    } catch {
      setStage("form"); setMessage("Не удалось связаться с сервером.");
    } finally { submitting.current=false; }
  }

  return <main className="auth-page"><section className="auth-card" aria-labelledby="registration-heading">
    <div className="auth-brand" aria-hidden="true">T</div>
    <p className="auth-eyebrow">Панель тренера</p>
    <h1 id="registration-heading">Регистрация в TrainerCRM</h1>
    {stage==="verifying" && <p role="status" className="auth-intro">Подтверждаем электронную почту…</p>}
    {stage==="verified" && <p role="status" className="auth-intro">Почта подтверждена! Кабинет создан. Теперь можно войти с вашим email и паролем.</p>}
    {stage==="sent" && <p role="status" className="auth-intro">Если адрес доступен для регистрации, мы отправили ссылку подтверждения. Проверьте входящие и «Спам». Ссылка действует 24 часа.</p>}
    {stage==="error" && <p role="alert" className="auth-form-error">{message}</p>}
    {(stage==="form" || stage==="sending") && <>
      <p className="auth-intro">Создайте отдельный кабинет тренера. Сначала подтвердите почту.</p>
      <form className="auth-form" noValidate onSubmit={submit}>
        <div><label htmlFor="signup-email">Электронная почта</label>
          <input id="signup-email" type="email" autoComplete="email" maxLength={254} required value={email}
            disabled={stage==="sending"} onChange={(e)=>setEmail(e.target.value)} /></div>
        <div><label htmlFor="signup-password">Пароль (от 8 символов)</label>
          <input id="signup-password" type="password" autoComplete="new-password" maxLength={1024} required value={password}
            disabled={stage==="sending"} onChange={(e)=>setPassword(e.target.value)} /></div>
        <div><label htmlFor="signup-repeat">Повторите пароль</label>
          <input id="signup-repeat" type="password" autoComplete="new-password" maxLength={1024} required value={repeat}
            disabled={stage==="sending"} onChange={(e)=>setRepeat(e.target.value)} /></div>
        {message && <p role="alert" className="auth-form-error">{message}</p>}
        <button type="submit" disabled={stage==="sending"}>{stage==="sending" ? "Отправляем…" : "Зарегистрироваться"}</button>
      </form>
    </>}
    <button type="button" className="mt-4 w-full min-h-11 rounded-xl border border-zinc-200 px-4 text-sm" onClick={onBack}>Вернуться ко входу</button>
  </section></main>;
}
