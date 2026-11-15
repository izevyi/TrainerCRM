import { createWorkoutHandlers } from "./handler";

const handlers = createWorkoutHandlers();
export const GET = handlers.GET;
export const PUT = handlers.PUT;
