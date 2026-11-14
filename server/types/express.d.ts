declare namespace Express {
  export interface Request {
    user: import("../src/lib/verifyJwt.js").Identity;
  }

  export interface Locals {
    deps: import("../src/deps.js").Deps;
  }
}
