import type { Request, Response } from "express";
import { z } from "zod";
import type { RouterObject } from "../../types/router.js";
import {
  BadRequestError,
  ForbiddenError,
  QuotaExceededError,
  UpstreamUnavailableError,
} from "../errors/httpErrors.js";
import { UpstreamError } from "../services/llm.js";

const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY = 200;

const chatBody = z.object({
  message: z.string().trim().min(1, "Message is empty").max(MAX_MESSAGE_CHARS, `Message is over ${MAX_MESSAGE_CHARS} characters`),
});

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY).default(50),
});

// One server-sent event. JSON keeps newlines inside the text from breaking the frame.
function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Counts one request against the caller's daily quota and the global one. If the global
// cap is hit, the caller's count is handed back so they aren't charged for nothing.
async function takeQuota(req: Request) {
  const { store, limits, today } = req.app.locals.deps;
  const day = today();
  const own = req.user.guest ? limits.DAILY_GUEST_LIMIT : limits.DAILY_USER_LIMIT;

  if (!(await store.consume(req.user.id, day, own))) {
    throw new QuotaExceededError(`You've used today’s ${own} messages. The limit resets at midnight UTC.`);
  }
  if (!(await store.consume("global", day, limits.DAILY_GLOBAL_LIMIT))) {
    await store.refund(req.user.id, day);
    throw new UpstreamUnavailableError("The chatbot has hit its daily limit. Try again tomorrow.", "GLOBAL_QUOTA_EXCEEDED");
  }
  return day;
}

async function chat(req: Request, res: Response) {
  const parsed = chatBody.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);
  const message = parsed.data.message;

  const { store, llm, limits } = req.app.locals.deps;
  const day = await takeQuota(req);

  // Guests get answers without memory; signed-in users get their recent turns as context.
  const context = req.user.guest || limits.CONTEXT_MESSAGES === 0 ? [] : await store.history(req.user.id, limits.CONTEXT_MESSAGES);

  // Stop generating (and stop paying for tokens) if the caller goes away.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  const tokens = llm.stream(context, message, controller.signal);

  // Wait for the first piece of the reply before committing to a 200, so a provider
  // failure up front still gets a proper status code.
  let first: IteratorResult<string>;
  try {
    first = await tokens.next();
  } catch (err) {
    await store.refund(req.user.id, day);
    if (err instanceof UpstreamError && err.status === 429) {
      throw new UpstreamUnavailableError("The model is busy, try again in a minute", "UPSTREAM_RATE_LIMITED");
    }
    throw new UpstreamUnavailableError();
  }

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Render and most proxies buffer responses unless told not to.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let answer = "";
  try {
    for (let step = first; !step.done; step = await tokens.next()) {
      answer += step.value;
      send(res, "delta", { text: step.value });
    }
  } catch {
    send(res, "error", { code: "UPSTREAM_ERROR", message: "The reply was cut off. Try again." });
    return res.end();
  }

  if (controller.signal.aborted) return res.end();

  // Only complete turns are saved, and only for signed-in users.
  const saved = !req.user.guest && answer.trim() ? await store.appendTurn(req.user.id, message, answer) : [];
  send(res, "done", { saved: saved.length > 0, messageId: saved[1]?.id ?? null });
  res.end();
}

const chatRouter: RouterObject = {
  path: "/chat",
  functions: [
    {
      method: "post",
      authorization: "required",
      rateLimit: "chat",
      keyType: "user",
      handler: chat,
    },
    {
      method: "get",
      props: "/history",
      authorization: "required",
      rateLimit: "read",
      keyType: "user",
      handler: async (req, res) => {
        if (req.user.guest) throw new ForbiddenError("Sign in to keep a chat history");
        const parsed = historyQuery.safeParse(req.query);
        if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);
        const messages = await req.app.locals.deps.store.history(req.user.id, parsed.data.limit);
        res.status(200).json({ messages });
      },
    },
    {
      method: "delete",
      props: "/history",
      authorization: "required",
      rateLimit: "strict",
      keyType: "user",
      handler: async (req, res) => {
        if (req.user.guest) throw new ForbiddenError("Sign in to keep a chat history");
        const deleted = await req.app.locals.deps.store.clear(req.user.id);
        res.status(200).json({ deleted });
      },
    },
  ],
};

export default chatRouter;
