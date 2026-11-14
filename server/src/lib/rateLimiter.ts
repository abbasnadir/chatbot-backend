import rateLimit, { ipKeyGenerator } from "express-rate-limit";

type keyType = "ip" | "user" | "default";

class RateLimiter {
  /* Dynamic rate limiting, based on the use case of API.
  Types are linked with `types/router.ts` so update it
  with this for adding new values.
  These are burst limits per minute; daily quotas live in the chat route.
  */
  private limits = {
    strict: { windowMs: 60_000, max: 10 },
    chat: { windowMs: 60_000, max: 6 },
    read: { windowMs: 60_000, max: 120 },
  } as const;

  limit(policy: keyof typeof this.limits, keyType: keyType) {
    return rateLimit({
      // Deconstruct the parameters passed earlier, based on dynamic policy
      ...this.limits[policy],
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res, _next, options) => {
        res.status(options.statusCode).json({
          error: { code: "RATE_LIMITED", message: "Too many requests, slow down" },
        });
      },

      /* Set the parameter on which rate-limiting will work.
      Defaults to `req.ip` if user is not defined. Used in combination
      with authHandler to return early if auth is must for rate limiting.
      */
      keyGenerator: (req) => {
        if (keyType === "user") return req.user.id;
        if (keyType === "ip") return ipKeyGenerator(req.ip!, 56);
        return req.user?.id ?? ipKeyGenerator(req.ip!, 56);
      },
    });
  }
}

export const rateLimiter = new RateLimiter();
