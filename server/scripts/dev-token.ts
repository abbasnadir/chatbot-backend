// Prints a token like the ones the Next.js app signs, for calling the API by hand with curl.
// Usage: pnpm tsx scripts/dev-token.ts [subject]   (default subject: dev-user; use guest:<ip> for a guest)
import "dotenv/config";
import { SignJWT } from "jose";
import { AUDIENCE, ISSUER } from "../src/lib/verifyJwt.js";

const secret = process.env.BACKEND_JWT_SECRET;
if (!secret) {
  console.error("Set BACKEND_JWT_SECRET (the same value the server uses).");
  process.exit(1);
}

const token = await new SignJWT({})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(process.argv[2] ?? "dev-user")
  .setIssuer(ISSUER)
  .setAudience(AUDIENCE)
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(new TextEncoder().encode(secret));

console.log(token);
