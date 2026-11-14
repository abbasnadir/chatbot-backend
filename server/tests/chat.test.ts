import { SignJWT } from "jose";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Deps } from "../src/deps.js";
import { AUDIENCE, ISSUER } from "../src/lib/verifyJwt.js";
import { UpstreamError, type LlmClient } from "../src/services/llm.js";
import { MemoryStore, type Message } from "../src/services/store.js";

const secret = new TextEncoder().encode("test-secret-that-is-at-least-32-characters");

async function token(sub: string, opts: { key?: Uint8Array; expires?: string } = {}) {
  return new SignJWT({ email: sub.startsWith("guest:") ? undefined : `${sub}@example.com` })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expires ?? "5m")
    .sign(opts.key ?? secret);
}

// A model that replies with fixed pieces and records what it was asked.
class FakeLlm implements LlmClient {
  calls: { context: Message[]; prompt: string }[] = [];
  reply = ["Hello", ", ", "world"];
  failBeforeFirst: UpstreamError | null = null;
  failAfter: number | null = null;

  async *stream(context: Message[], prompt: string) {
    this.calls.push({ context, prompt });
    if (this.failBeforeFirst) throw this.failBeforeFirst;
    for (const [i, piece] of this.reply.entries()) {
      if (this.failAfter === i) throw new UpstreamError("stream broke", 500);
      yield piece;
    }
  }
}

type Event = { event: string; data: any };

function parseEvents(body: string): Event[] {
  return body
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const event = frame.match(/^event: (.*)$/m)?.[1] ?? "message";
      const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? "null");
      return { event, data };
    });
}

// Supertest doesn't buffer event streams by default.
const sse = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (text += chunk));
    res.on("end", () => done(null, text));
  });

let store: MemoryStore;
let llm: FakeLlm;
let deps: Deps;

beforeEach(() => {
  store = new MemoryStore();
  llm = new FakeLlm();
  deps = {
    store,
    llm,
    jwtSecret: secret,
    limits: { CONTEXT_MESSAGES: 10, DAILY_USER_LIMIT: 3, DAILY_GUEST_LIMIT: 1, DAILY_GLOBAL_LIMIT: 100 },
    today: () => "2026-11-11",
  };
});

describe("auth", () => {
  it("rejects requests without a token", async () => {
    const app = await createApp(deps);
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects tokens signed with another secret", async () => {
    const app = await createApp(deps);
    const bad = await token("u1", { key: new TextEncoder().encode("x".repeat(40)) });
    const res = await request(app).post("/chat").set("Authorization", `Bearer ${bad}`).send({ message: "hi" });
    expect(res.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const app = await createApp(deps);
    const old = await token("u1", { expires: "-1m" });
    const res = await request(app).get("/me").set("Authorization", `Bearer ${old}`);
    expect(res.status).toBe(401);
  });

  it("reports who the caller is", async () => {
    const app = await createApp(deps);
    const res = await request(app).get("/me").set("Authorization", `Bearer ${await token("guest:1.2.3.4")}`);
    expect(res.body).toEqual({ id: "guest:1.2.3.4", email: null, guest: true });
  });
});

describe("POST /chat", () => {
  it("streams the reply and saves the whole turn", async () => {
    const app = await createApp(deps);
    const res = await sse(request(app).post("/chat").set("Authorization", `Bearer ${await token("u1")}`).send({ message: "  hi there " }));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseEvents(res.body);
    expect(events.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe("Hello, world");
    expect(events.at(-1)).toMatchObject({ event: "done", data: { saved: true } });

    const saved = await store.history("u1", 10);
    expect(saved.map((m) => [m.role, m.text])).toEqual([
      ["user", "hi there"],
      ["model", "Hello, world"],
    ]);
  });

  it("sends earlier turns to the model as context", async () => {
    const app = await createApp(deps);
    const auth = `Bearer ${await token("u1")}`;
    await sse(request(app).post("/chat").set("Authorization", auth).send({ message: "first" }));
    await sse(request(app).post("/chat").set("Authorization", auth).send({ message: "second" }));

    expect(llm.calls[1]!.context.map((m) => m.text)).toEqual(["first", "Hello, world"]);
    expect(llm.calls[1]!.prompt).toBe("second");
  });

  it("answers guests without saving anything or using context", async () => {
    const app = await createApp(deps);
    const res = await sse(request(app).post("/chat").set("Authorization", `Bearer ${await token("guest:1.2.3.4")}`).send({ message: "hi" }));

    expect(parseEvents(res.body).at(-1)).toMatchObject({ event: "done", data: { saved: false } });
    expect(await store.history("guest:1.2.3.4", 10)).toEqual([]);
    expect(llm.calls[0]!.context).toEqual([]);
  });

  it("validates the message", async () => {
    const app = await createApp(deps);
    const auth = `Bearer ${await token("u1")}`;
    expect((await request(app).post("/chat").set("Authorization", auth).send({ message: "   " })).status).toBe(400);
    expect((await request(app).post("/chat").set("Authorization", auth).send({ message: "x".repeat(4001) })).status).toBe(400);
    expect((await request(app).post("/chat").set("Authorization", auth).send({})).status).toBe(400);
    expect(llm.calls).toHaveLength(0);
  });

  it("enforces the daily quota per caller", async () => {
    const app = await createApp(deps);
    const auth = `Bearer ${await token("guest:5.6.7.8")}`;
    expect((await sse(request(app).post("/chat").set("Authorization", auth).send({ message: "one" }))).status).toBe(200);

    const res = await request(app).post("/chat").set("Authorization", auth).send({ message: "two" });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("QUOTA_EXCEEDED");
    expect(llm.calls).toHaveLength(1);
  });

  it("stops everyone at the global cap without charging the caller", async () => {
    deps.limits.DAILY_GLOBAL_LIMIT = 1;
    const app = await createApp(deps);
    await sse(request(app).post("/chat").set("Authorization", `Bearer ${await token("u1")}`).send({ message: "one" }));

    const res = await request(app).post("/chat").set("Authorization", `Bearer ${await token("u2")}`).send({ message: "two" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("GLOBAL_QUOTA_EXCEEDED");
    // u2 was refunded, so the next day-limited request is still allowed for them.
    expect(await store.consume("u2", "2026-11-11", 1)).toBe(true);
  });

  it("maps a provider failure before the first token to a status code and refunds the quota", async () => {
    llm.failBeforeFirst = new UpstreamError("quota", 429);
    const app = await createApp(deps);
    const res = await request(app).post("/chat").set("Authorization", `Bearer ${await token("u1")}`).send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(await store.consume("u1", "2026-11-11", 1)).toBe(true);
  });

  it("reports a broken stream as an event and saves no half answer", async () => {
    llm.failAfter = 2;
    const app = await createApp(deps);
    const res = await sse(request(app).post("/chat").set("Authorization", `Bearer ${await token("u1")}`).send({ message: "hi" }));

    const events = parseEvents(res.body);
    expect(events.map((e) => e.event)).toEqual(["delta", "delta", "error"]);
    expect(await store.history("u1", 10)).toEqual([]);
  });
});

describe("/chat/history", () => {
  it("returns and clears a user's own messages only", async () => {
    const app = await createApp(deps);
    await store.appendTurn("u1", "mine", "reply");
    await store.appendTurn("u2", "theirs", "reply");
    const auth = `Bearer ${await token("u1")}`;

    const list = await request(app).get("/chat/history").set("Authorization", auth);
    expect(list.status).toBe(200);
    expect(list.body.messages.map((m: Message) => m.text)).toEqual(["mine", "reply"]);

    const cleared = await request(app).delete("/chat/history").set("Authorization", auth);
    expect(cleared.body).toEqual({ deleted: 2 });
    expect(await store.history("u2", 10)).toHaveLength(2);
  });

  it("is not available to guests", async () => {
    const app = await createApp(deps);
    const res = await request(app).get("/chat/history").set("Authorization", `Bearer ${await token("guest:1.2.3.4")}`);
    expect(res.status).toBe(403);
  });
});

describe("misc", () => {
  it("has a health check and a JSON 404", async () => {
    const app = await createApp(deps);
    expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
    const missing = await request(app).get("/nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
});
