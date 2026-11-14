# chatbot-backend

The API behind [chatbot](https://github.com/abbasnadir/chatbot): it streams replies from Google Gemini, keeps each user’s chat history in MongoDB, and rations a shared API key with daily quotas.

Only the Next.js server talks to it. For every request, the Next.js app signs a token that lives five minutes and carries the user’s id (or `guest:<ip>` for visitors who aren’t signed in), so this server needs no sessions, cookies or CORS.

## What it does

- **Streams replies** over server-sent events as Gemini generates them. If the browser goes away, generation is cancelled.
- **Remembers the conversation** for signed-in users: the last 10 messages go to the model as context. A question and its answer are saved together once the reply is complete, so a failed reply never leaves half a turn behind.
- **Protects the key**: a burst limit of 6 chats a minute per caller, then daily quotas counted in MongoDB (50 per user, 10 per guest, 500 in total). If the global cap or Gemini refuses a request, the caller’s quota is handed back.
- **Fails clearly**: errors before the first token get a status code and a machine-readable code; after streaming starts, an `error` event ends the stream.

The API is described in [design/api-design.yml](design/api-design.yml), the request flow in [design/userflow.md](design/userflow.md), and the constraints behind these choices in [design/constraints.md](design/constraints.md).

| Method and path | Auth | What it does |
| --- | --- | --- |
| `GET /health` | none | `{"status":"ok"}`, used as the Render health check |
| `GET /me` | token | Who the token says the caller is |
| `POST /chat` | token | Streams a reply to `{"message": "..."}` (up to 4000 characters) |
| `GET /chat/history?limit=50` | token, signed-in users | The caller’s saved messages, oldest first (limit 1 to 200) |
| `DELETE /chat/history` | token, signed-in users | Deletes the caller’s messages |

## Example

A real request and response, captured from this server running locally with MongoDB in Docker and a stand-in model in place of Gemini (so the reply text is canned; the event framing, chunking into `delta` events and the saved turn are the real server’s):

```bash
TOKEN=$(pnpm -s tsx scripts/dev-token.ts)
curl -N http://localhost:5000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"What is a mutex?"}'
```

```text
event: delta
data: {"text":"A mutex (short for mutual exclusion) is a"}

event: delta
data: {"text":" lock that lets only one thread use a"}

event: delta
data: {"text":" shared resource at a time. A thread locks"}

event: delta
data: {"text":" the mutex before touching the resource and unlocks"}

event: delta
data: {"text":" it when done; any other thread that tries"}

event: delta
data: {"text":" to lock it in the meantime waits. This"}

event: delta
data: {"text":" prevents race conditions, where two threads change the"}

event: delta
data: {"text":" same data at once and leave it in"}

event: delta
data: {"text":" a broken state."}

event: done
data: {"saved":true,"messageId":"6af85df6793e986c26adf3f0"}
```

The turn is then in the history:

```bash
curl "http://localhost:5000/chat/history?limit=2" -H "Authorization: Bearer $TOKEN"
```

```text
{"messages":[{"id":"6af85df6793e986c26adf3ef","role":"user","text":"What is a mutex?","createdAt":"2026-11-14T13:11:18.604Z"},{"id":"6af85df6793e986c26adf3f0","role":"model","text":"A mutex (short for mutual exclusion) is a lock that lets only one thread use a shared resource at a time. A thread locks the mutex before touching the resource and unlocks it when done; any other thread that tries to lock it in the meantime waits. This prevents race conditions, where two threads change the same data at once and leave it in a broken state.","createdAt":"2026-11-14T13:11:18.605Z"}]}
```

Errors are JSON with a code, for example a guest asking for history, or a request with no token:

```text
HTTP/1.1 403 Forbidden
{"error":{"code":"FORBIDDEN","message":"Sign in to keep a chat history"}}

HTTP/1.1 401 Unauthorized
{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}
```

## Run it locally

You need Node 22 or newer, pnpm, Docker (for MongoDB) and a Gemini API key.

```bash
docker run -d --name chatbot-mongo -p 27017:27017 mongo:7

cd server
pnpm install
cp .env.example .env   # fill in the values below
pnpm dev               # http://localhost:5000
```

| Variable | Purpose |
| --- | --- |
| `BACKEND_JWT_SECRET` | Shared with the Next.js app, which signs a token per request. At least 32 characters (`openssl rand -base64 48`) |
| `MONGODB_URI` | MongoDB connection string, e.g. `mongodb://localhost:27017` |
| `MONGODB_DB` | Database name (default `chatbot`) |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GEMINI_MODEL` | Model name (default `gemini-2.5-flash`) |
| `MAX_OUTPUT_TOKENS` | Cap on reply length (default 1024) |
| `CONTEXT_MESSAGES` | Earlier messages sent as context (default 10, 0 turns it off) |
| `DAILY_USER_LIMIT`, `DAILY_GUEST_LIMIT`, `DAILY_GLOBAL_LIMIT` | Daily quotas (defaults 50, 10, 500) |
| `PORT` | Port to listen on (default 5000) |

The server checks these at startup and refuses to boot if one is missing or invalid.

To call the API by hand, `pnpm -s tsx scripts/dev-token.ts` prints a token like the ones the Next.js app signs, using `BACKEND_JWT_SECRET` from `.env`. Pass a subject to choose the caller, e.g. `scripts/dev-token.ts guest:203.0.113.7` for a guest.

### Tests

Tests run against an in-memory store and a fake model, so they need neither MongoDB nor a Gemini key:

```bash
pnpm test
```

```text
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

They cover token checks (missing, wrong secret, expired), streaming and saving a whole turn, context for signed-in users only, validation, per-caller and global quotas with refunds, provider failures before and during the stream, and history access. `pnpm typecheck` runs `tsc --noEmit`.

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
  scripts/              dev-token.ts for manual calls, import-legacy.ts for a one-off migration
```
