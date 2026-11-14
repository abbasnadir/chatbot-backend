import type { Env } from "./lib/env.js";
import type { LlmClient } from "./services/llm.js";
import type { ChatStore } from "./services/store.js";

// What the routes need at runtime. Built in server.ts for production and by hand in
// tests, then attached to app.locals so routes never import a global client.
export type Deps = {
  store: ChatStore;
  llm: LlmClient;
  jwtSecret: Uint8Array;
  limits: Pick<Env, "CONTEXT_MESSAGES" | "DAILY_USER_LIMIT" | "DAILY_GUEST_LIMIT" | "DAILY_GLOBAL_LIMIT">;
  // Injected so tests can pin the date that quotas are counted against.
  today: () => string;
};

export const utcDay = () => new Date().toISOString().slice(0, 10);
