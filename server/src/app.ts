// Library imports
import express, { type Express } from "express";
import logger from "morgan";

// Module imports
import type { Deps } from "./deps.js";
import { routesHandler } from "./lib/routeHandler.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { NotFoundError } from "./errors/httpErrors.js";

// Builds the app around its dependencies, so tests can pass an in-memory store and a fake model.
// Only the Next.js server calls this API (server to server), so there is no CORS and no cookies.
export async function createApp(deps: Deps): Promise<Express> {
  const app = express();
  app.locals.deps = deps;

  // Render sits in front of the app; trust its one proxy hop for req.ip.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  if (process.env.NODE_ENV !== "test") app.use(logger("dev"));
  app.use(express.json({ limit: "32kb" }));

  // Register App routes
  app.use(await routesHandler());

  // catch 404 and forward to error handler
  app.use(() => {
    throw new NotFoundError();
  });

  // error handler
  app.use(errorHandler);

  return app;
}
