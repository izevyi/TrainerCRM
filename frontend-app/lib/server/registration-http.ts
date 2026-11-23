export const REGISTRATION_REQUEST_MAX_BYTES = 4096;

export async function limitedJsonBody(request: Request, maxBytes = REGISTRATION_REQUEST_MAX_BYTES): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("INVALID_REQUEST");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_REQUEST");
  let length = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("INVALID_REQUEST");
      }
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch { throw new Error("INVALID_REQUEST"); }
}

export function allowedRegistrationOrigin(request: Request, env: Readonly<Record<string,string|undefined>> = process.env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser callers still have durable limits
  const allowed = env.NODE_ENV === "production" ? "https://trainer-crm.ru" : new URL(request.url).origin;
  return origin === allowed;
}
