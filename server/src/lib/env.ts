import { z } from "zod";

// Every setting the server reads, validated once at startup so a missing key fails
// the boot instead of the first request.
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),

  // Shared with the Next.js app, which signs a short-lived token for every request.
  BACKEND_JWT_SECRET: z.string().min(32, "BACKEND_JWT_SECRET must be at least 32 characters"),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default("chatbot"),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024),

  // How many earlier messages are sent back to the model as context.
  CONTEXT_MESSAGES: z.coerce.number().int().min(0).default(10),

  // Daily request quotas. The API key is shared, so the global cap protects it.
  DAILY_USER_LIMIT: z.coerce.number().int().positive().default(50),
  DAILY_GUEST_LIMIT: z.coerce.number().int().positive().default(10),
  DAILY_GLOBAL_LIMIT: z.coerce.number().int().positive().default(500),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${problems}`);
  }
  return parsed.data;
}
