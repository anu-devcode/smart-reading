import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccountDto, SessionDto } from "../../shared/types.ts";
import { AccountError, SESSION_DAYS, SignInThrottle, type Accounts } from "../accounts.ts";
import type { Libraries } from "../libraries.ts";
import { HttpError } from "../errors.ts";

export const SESSION_COOKIE = "sr_session";

export function readSessionToken(req: FastifyRequest): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim() || undefined;
  }
  return undefined;
}

function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, maxAge = SESSION_DAYS * 86400) {
  const secure = req.protocol === "https" ? "; Secure" : "";
  reply.header("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

const fail = (e: unknown): never => {
  if (e instanceof AccountError) throw new HttpError(e.status, e.message);
  throw e;
};

function requireAccount(req: FastifyRequest): AccountDto {
  if (!req.account) throw new HttpError(401, "Sign in first.");
  return req.account;
}

function requireAdmin(req: FastifyRequest): AccountDto {
  const a = requireAccount(req);
  if (!a.isAdmin) throw new HttpError(403, "Only the owner of this server can manage accounts.");
  return a;
}

export function registerAuthRoutes(app: FastifyInstance, accounts: Accounts, libraries: Libraries) {
  const throttle = new SignInThrottle();
  let settingUp = false;

  app.get("/api/auth/session", async (req): Promise<SessionDto> => ({
    accounts: true,
    setupNeeded: accounts.count() === 0,
    account: req.account,
  }));

  // The first person to open a new server creates the owner account. Any library that existed before
  // accounts were turned on becomes theirs.
  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/setup", async (req, reply) => {
    if (settingUp || accounts.count() > 0) throw new HttpError(409, "This server already has an owner. Sign in instead.");
    settingUp = true;
    try {
      const account = await accounts.create(req.body?.username ?? "", req.body?.password ?? "", true).catch(fail);
      libraries.adoptLegacy(account.id);
      setSessionCookie(req, reply, accounts.createSession(account.id));
      return { account };
    } finally {
      settingUp = false;
    }
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
    const username = (req.body?.username ?? "").trim();
    const key = `${req.ip}|${username.toLowerCase()}`;
    const wait = throttle.wait(key);
    if (wait > 0) {
      reply.header("Retry-After", String(Math.ceil(wait / 1000)));
      throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil(wait / 1000)} seconds.`);
    }
    const account = await accounts.verify(username, req.body?.password ?? "");
    if (!account) {
      throttle.failed(key);
      throw new HttpError(401, "That username and password do not match.");
    }
    throttle.succeeded(key);
    setSessionCookie(req, reply, accounts.createSession(account.id));
    return { account };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = readSessionToken(req);
    if (token) accounts.endSession(token);
    setSessionCookie(req, reply, "", 0);
    return { ok: true };
  });

  app.post<{ Body: { current?: string; next?: string } }>("/api/auth/password", async (req) => {
    const me = requireAccount(req);
    if (!(await accounts.verify(me.username, req.body?.current ?? ""))) throw new HttpError(403, "Your current password is not right.");
    await accounts.setPassword(me.id, req.body?.next ?? "").catch(fail);
    accounts.endSessionsFor(me.id, readSessionToken(req)); // other devices must sign in again
    return { ok: true };
  });

  // ---- accounts: managed by the owner; there is no open sign-up ----
  app.get("/api/accounts", async (req): Promise<AccountDto[]> => {
    requireAdmin(req);
    return accounts.list();
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/accounts", async (req) => {
    requireAdmin(req);
    return accounts.create(req.body?.username ?? "", req.body?.password ?? "").catch(fail);
  });

  app.post<{ Params: { id: string }; Body: { password?: string } }>("/api/accounts/:id/password", async (req) => {
    requireAdmin(req);
    const target = accounts.get(Number(req.params.id));
    if (!target) throw new HttpError(404, "Account not found");
    await accounts.setPassword(target.id, req.body?.password ?? "").catch(fail);
    accounts.endSessionsFor(target.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>("/api/accounts/:id", async (req) => {
    const me = requireAdmin(req);
    const target = accounts.get(Number(req.params.id));
    if (!target) throw new HttpError(404, "Account not found");
    if (target.id === me.id) throw new HttpError(400, "You cannot remove your own account.");
    if ((req.query.confirm ?? "").toLowerCase() !== target.username.toLowerCase()) {
      throw new HttpError(400, `Type the username "${target.username}" to confirm. Their whole library is deleted.`);
    }
    accounts.endSessionsFor(target.id);
    accounts.remove(target.id);
    await libraries.remove(target.id);
    return { ok: true };
  });
}
