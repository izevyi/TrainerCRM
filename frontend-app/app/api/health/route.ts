import { checkDatabaseHealth } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function GET(): Promise<Response> {
  const available = await checkDatabaseHealth();

  if (!available) {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }

  return Response.json(
    { status: "ok" },
    { status: 200, headers: RESPONSE_HEADERS },
  );
}
