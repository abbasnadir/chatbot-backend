import type { Request, Response } from "express";
import type { RouterObject } from "../../types/router.js";

/* Who the backend thinks the caller is. Useful when wiring up a new client. */
const meRouter: RouterObject = {
  path: "/me",
  functions: [
    {
      method: "get",
      authorization: "required",
      rateLimit: "strict",
      keyType: "user",
      handler: (req: Request, res: Response) => {
        res.status(200).json({
          id: req.user.id,
          email: req.user.email ?? null,
          guest: req.user.guest,
        });
      },
    },
  ],
};

export default meRouter;
