import { createAppointmentHandlers } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { PATCH, DELETE } = createAppointmentHandlers();
