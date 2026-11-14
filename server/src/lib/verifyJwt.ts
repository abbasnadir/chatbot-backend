import { jwtVerify } from "jose";
import { UnauthorizedError } from "../errors/httpErrors.js";

export const ISSUER = "chatbot-web";
export const AUDIENCE = "chatbot-backend";

export type Identity = {
  id: string;
  email: string | undefined;
  guest: boolean;
};

// Tokens are minted by the Next.js server for each request (HS256, shared secret,
// a few minutes of life). Guests get a subject of the form "guest:<ip>".
export default async function verifyJwt(token: string, secret: Uint8Array): Promise<Identity> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["HS256"],
  });

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new UnauthorizedError();
  }

  const guest = payload.sub.startsWith("guest:");
  return {
    id: payload.sub,
    email: guest || typeof payload.email !== "string" ? undefined : payload.email,
    guest,
  };
}
