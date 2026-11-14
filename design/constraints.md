Design Constraints

- Limited Gemini API key use. Every request counts against a daily quota per user (50), per guest IP (10) and a global cap (500), stored in MongoDB so restarts don't reset them. On top of that, a burst limit of 6 chat requests a minute per caller.
- A reply must start appearing quickly, so it is streamed token by token over server-sent events.
- If the caller disconnects, generation stops, so no tokens are spent on a reply nobody reads.
- Only complete turns are saved: a question and its answer are written together after the reply finishes.
- Guests can chat but get no history and no context.
- The browser never talks to this server. The Next.js server signs a short-lived token per request, so the backend needs no cookies, sessions or CORS.
- Free hosting (Render free tier) sleeps after inactivity, so the first request after a while is slow.
