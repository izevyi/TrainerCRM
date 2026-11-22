import { createWeightHandlers } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { GET, POST, PUT, DELETE } = createWeightHandlers();
