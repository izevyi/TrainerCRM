import { createWorkoutsHandlers } from "./handler";

const handlers = createWorkoutsHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
