# chatbot-backend

The API behind [chatbot](https://github.com/abbasnadir/chatbot): it streams replies from Google Gemini, keeps each user’s chat history in MongoDB, and rations a shared API key with daily quotas.

Only the Next.js server talks to it. For every request, the Next.js app signs a token that lives five minutes and carries the user’s id (or `guest:<ip>` for visitors who aren’t signed in), so this server needs no sessions, cookies or CORS.

## What it does

- **Streams replies** over server-sent events as Gemini generates them. If the browser goes away, generation is cancelled.
- **Remembers the conversation** for signed-in users: the last 10 messages go to the model as context. A question and its answer are saved together once the reply is complete, so a failed reply never leaves half a turn behind.
- **Protects the key**: a burst limit of 6 chats a minute per caller, then daily quotas counted in MongoDB (50 per user, 10 per guest, 500 in total). If the global cap or Gemini refuses a request, the caller’s quota is handed back.
- **Fails clearly**: errors before the first token get a status code and a machine-readable code; after streaming starts, an `error` event ends the stream.

The API is described in [design/api-design.yml](design/api-design.yml), the request flow in [design/userflow.md](design/userflow.md), and the constraints behind these choices in [design/constraints.md](design/constraints.md).

## Example

```bash
curl -N http://localhost:5000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"What is a mutex?"}'
```

```text
event: delta
data: {"text":"A mutex is a lock that"}

event: delta
data: {"text":" lets only one thread use a resource at a time."}

event: done
data: {"saved":true,"messageId":"673f0c..."}
```

## Run it

```bash
cd server
pnpm install
cp .env.example .env   # fill in BACKEND_JWT_SECRET, MONGODB_URI and GEMINI_API_KEY
pnpm dev
```

Tests run against an in-memory store and a fake model, so they need neither MongoDB nor a Gemini key:

```bash
pnpm test
```

## Deploy

`render.yaml` defines a Render web service (free plan) with `/health` as the health check. Set `BACKEND_JWT_SECRET`, `MONGODB_URI` and `GEMINI_API_KEY` in the Render dashboard, then set `BACKEND_URL` and the same `BACKEND_JWT_SECRET` in the Next.js app on Vercel.

Chats saved by the old version of the frontend can be imported once with `LEGACY_DB=<frontend database> pnpm tsx scripts/import-legacy.ts --dry-run` (drop `--dry-run` to write).

## Structure

```text
server/
  src/
    app.ts              builds the Express app around its dependencies
    server.ts           wires MongoDB and Gemini, starts listening, shuts down cleanly
    routes/             one file per path; the loader mounts them with auth and rate limits
    services/llm.ts     the Gemini client behind an LlmClient interface
    services/store.ts   MongoDB storage and quota counters behind a ChatStore interface
    lib/                env validation, token verification, rate limits, route loader
  tests/                API tests with supertest
  scripts/              one-off maintenance scripts
```
