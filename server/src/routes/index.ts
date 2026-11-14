import type { Request, Response } from "express";
import type { RouterObject } from "../../types/router.js";

/* Health check, used by Render to decide whether a deploy is live. */
const indexRouter: RouterObject = {
  path: "/health",
  functions: [
    {
      method: "get",
      authorization: "none",
      rateLimit: "read",
      keyType: "ip",
      handler: (_req: Request, res: Response) => {
        res.status(200).json({ status: "ok" });
      },
    },
  ],
};

export default indexRouter;
