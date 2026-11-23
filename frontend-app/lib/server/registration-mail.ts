import { randomBytes } from "node:crypto";
import * as tls from "node:tls";
import type { TLSSocket } from "node:tls";

// Minimal SMTP-over-TLS transport: fixed Selectel host, verified certificate,
// no STARTTLS downgrade, no shell calls, no dependency or credential logging.
// All message headers are ASCII; Russian body is MIME base64 encoded.
type Reply = { code: number; text: string };

class SmtpChannel {
  private buffer = "";
  private lines: string[] = [];
  private replies: Reply[] = [];
  private pending: { resolve: (r: Reply) => void; reject: (error: Error) => void } | null = null;
  private failed: Error | null = null;

  constructor(private readonly socket: TLSSocket) {
    socket.setTimeout(20_000, () => socket.destroy(new Error("SMTP_TIMEOUT")));
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > 16_384) {
        socket.destroy(new Error("SMTP_REPLY_TOO_LARGE"));
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf("\r\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (!/^\d{3}[ -]/.test(line)) {
          socket.destroy(new Error("SMTP_MALFORMED_REPLY"));
          return;
        }
        this.lines.push(line);
        if (line[3] === " ") {
          const reply = { code: Number(line.slice(0,3)), text: this.lines.join("\n") };
          this.lines = [];
          if (this.pending) {
            const pending = this.pending;
            this.pending = null;
            pending.resolve(reply);
          } else {
            this.replies.push(reply);
          }
        }
      }
    });
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("SMTP_CONNECTION_CLOSED")));
  }

  private fail(error: Error) {
    this.failed = error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.reject(error);
    }
  }
  next(): Promise<Reply> {
    if (this.replies.length) return Promise.resolve(this.replies.shift()!);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  async command(command: string, expected: number | number[]): Promise<Reply> {
    this.socket.write(command + "\r\n");
    const reply = await this.next();
    if (!(Array.isArray(expected) ? expected : [expected]).includes(reply.code)) {
      // Never expose remote SMTP responses; they can echo addresses/secrets.
      throw new Error("SMTP_REJECTED_" + reply.code);
    }
    return reply;
  }
  async data(message: string): Promise<void> {
    // Base64 encoding and ASCII headers ensure no user-controlled dot-commands.
    this.socket.write(message + "\r\n.\r\n");
    const reply = await this.next();
    if (reply.code !== 250) throw new Error("SMTP_DATA_REJECTED_" + reply.code);
  }
}

function config(env: Readonly<Record<string,string|undefined>>) {
  const host = env.TRAINERCRM_SMTP_HOST;
  const port = env.TRAINERCRM_SMTP_PORT;
  const login = env.TRAINERCRM_SMTP_LOGIN;
  const key = env.TRAINERCRM_SMTP_API_KEY;
  const sender = env.TRAINERCRM_SMTP_FROM;
  if (host !== "smtp.mail.selcloud.ru" || port !== "1127" ||
      !login || !/^\d{1,12}$/.test(login) || !key ||
      !/^[A-Za-z0-9_-]{8,256}$/.test(key) ||
      sender !== "no-reply@trainer-crm.ru") {
    throw new Error("SMTP_CONFIG_UNAVAILABLE");
  }
  return { host, port:1127, login, key, sender };
}

export async function sendRegistrationEmail(
  email: string,
  token: string,
  environment: Readonly<Record<string,string|undefined>> = process.env,
): Promise<void> {
  const smtp = config(environment);
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+$/.test(email)) {
    throw new Error("SMTP_RECIPIENT_INVALID");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("SMTP_TOKEN_INVALID");
  const link = "https://trainer-crm.ru/#verify=" + encodeURIComponent(token);
  const body = [
    "Вы запросили регистрацию тренера в TrainerCRM.",
    "Для подтверждения email откройте ссылку (действует 24 часа):",
    link,
    "",
    "Если это были не вы, просто проигнорируйте сообщение.",
  ].join("\n");
  const base64 = Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const message = [
    "From: <" + smtp.sender + ">",
    "To: <" + email + ">",
    "Subject: Confirm your TrainerCRM registration",
    "Date: " + new Date().toUTCString(),
    "Message-ID: <" + randomBytes(12).toString("hex") + "@trainer-crm.ru>",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64,
  ].join("\r\n");

  const socket = tls.connect({
    host: smtp.host, port:smtp.port, servername:smtp.host,
    rejectUnauthorized:true,
  });
  const channel = new SmtpChannel(socket);
  try {
    const banner = await channel.next();
    if (banner.code !== 220) throw new Error("SMTP_BANNER_INVALID");
    await channel.command("EHLO trainer-crm.ru", 250);
    // Authenticate over verified TLS. Never put the key in logs.
    const plain = Buffer.from("\0"+smtp.login+"\0"+smtp.key).toString("base64");
    const auth = await channel.command("AUTH PLAIN " + plain, [235, 334, 500, 502, 504]);
    if (auth.code === 334) {
      await channel.command(plain, 235);
    } else if (auth.code !== 235) {
      // Some SMTP relays advertise LOGIN but not PLAIN.
      await channel.command("AUTH LOGIN", 334);
      await channel.command(Buffer.from(smtp.login).toString("base64"), 334);
      await channel.command(Buffer.from(smtp.key).toString("base64"), 235);
    }
    await channel.command("MAIL FROM:<"+smtp.sender+">", 250);
    await channel.command("RCPT TO:<"+email+">", [250,251]);
    await channel.command("DATA", 354);
    await channel.data(message);
    await channel.command("QUIT", 221);
  } finally {
    socket.destroy();
  }
}
