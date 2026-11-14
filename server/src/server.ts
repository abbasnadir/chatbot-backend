import "dotenv/config";
import { createApp } from "./app.js";
import { utcDay } from "./deps.js";
import { loadEnv } from "./lib/env.js";
import { GeminiClient } from "./services/llm.js";
import { MongoStore } from "./services/store.js";

const env = loadEnv();
const store = await MongoStore.connect(env.MONGODB_URI, env.MONGODB_DB);

const app = await createApp({
  store,
  llm: new GeminiClient(env.GEMINI_API_KEY, env.GEMINI_MODEL, env.MAX_OUTPUT_TOKENS),
  jwtSecret: new TextEncoder().encode(env.BACKEND_JWT_SECRET),
  limits: env,
  today: utcDay,
});

const server = app.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT} with model ${env.GEMINI_MODEL}`);
});

// Render sends SIGTERM before replacing an instance; let open streams finish first.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  });
}
