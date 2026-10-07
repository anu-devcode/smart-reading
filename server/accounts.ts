import Database from "better-sqlite3";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { join } from "node:path";
import type { AccountDto } from "../shared/types.ts";
import type { DB } from "./db.ts";

// Who may use this server. Each account's library lives in its own folder (see libraries.ts), so this
// database holds only names, password hashes and sessions; never any reading data.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused: an id names a library folder
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`;

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
export const MIN_PASSWORD = 10;
export const SESSION_DAYS = 30;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((res, rej) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? rej(err) : res(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface UserRow {
  id: number;
  username: string;
  password: string;
  is_admin: number;
  created_at: string;
}

const toDto = (r: UserRow): AccountDto => ({ id: r.id, username: r.username, isAdmin: !!r.is_admin, createdAt: r.created_at });

export class Accounts {
  readonly db: DB;
  /** checked against when the name does not exist, so a wrong name and a wrong password take as long */
  private dummyHash: Promise<string>;

  constructor(rootDir: string) {
    this.db = new Database(join(rootDir, "accounts.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.dummyHash = hashPassword(randomBytes(12).toString("hex"));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
  }

  list(): AccountDto[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY id").all() as UserRow[]).map(toDto);
  }

  get(id: number): AccountDto | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return r ? toDto(r) : null;
  }

  async create(username: string, password: string, isAdmin = false): Promise<AccountDto> {
    const name = username.trim();
    if (!USERNAME_PATTERN.test(name)) {
      throw new AccountError("A username is 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.");
    }
    checkNewPassword(password);
    if (this.db.prepare("SELECT 1 FROM users WHERE username = ?").get(name)) {
      throw new AccountError(`The username "${name}" is already taken.`, 409);
    }
    const hash = await hashPassword(password);
    const info = this.db
      .prepare("INSERT INTO users(username, password, is_admin, created_at) VALUES (?,?,?,?)")
      .run(name, hash, isAdmin ? 1 : 0, new Date().toISOString());
    return this.get(Number(info.lastInsertRowid))!;
  }

  async verify(username: string, password: string): Promise<AccountDto | null> {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim()) as UserRow | undefined;
    if (!r) {
      await checkPassword(password, await this.dummyHash);
      return null;
    }
    return (await checkPassword(password, r.password)) ? toDto(r) : null;
  }

  async setPassword(id: number, password: string): Promise<void> {
    checkNewPassword(password);
    this.db.prepare("UPDATE users SET password = ? WHERE id = ?").run(await hashPassword(password), id);
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  // ---------- sessions: the browser holds a random token, the database only its hash ----------

  createSession(userId: number): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db
      .prepare("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)")
      .run(sha256(token), userId, new Date(now).toISOString(), new Date(now + SESSION_DAYS * 864e5).toISOString());
    return token;
  }

  /** The signed-in account for a token; using a session keeps it alive for another SESSION_DAYS. */
  sessionAccount(token: string | undefined): AccountDto | null {
    if (!token) return null;
    const h = sha256(token);
    const s = this.db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(h) as
      | { user_id: number; expires_at: string }
      | undefined;
    if (!s) return null;
    const now = Date.now();
    if (Date.parse(s.expires_at) <= now) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(h);
      return null;
    }
    if (Date.parse(s.expires_at) - now < (SESSION_DAYS - 1) * 864e5) {
      this.db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(new Date(now + SESSION_DAYS * 864e5).toISOString(), h);
    }
    return this.get(s.user_id);
  }

  endSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  /** Sign an account out everywhere, optionally except the session making the change. */
  endSessionsFor(userId: number, exceptToken?: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, exceptToken ? sha256(exceptToken) : "");
  }

  close(): void {
    this.db.close();
  }
}

function checkNewPassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new AccountError(`Use a password of at least ${MIN_PASSWORD} characters.`);
  }
}

/** Slows down password guessing: after 5 wrong tries for a name from one address, waits grow from 30 s to 15 min. */
export class SignInThrottle {
  private tries = new Map<string, { fails: number; until: number }>();

  /** milliseconds to wait before another try is allowed (0 = go ahead) */
  wait(key: string, now = Date.now()): number {
    const t = this.tries.get(key);
    return t && t.until > now ? t.until - now : 0;
  }

  failed(key: string, now = Date.now()): void {
    const t = this.tries.get(key) ?? { fails: 0, until: 0 };
    t.fails++;
    if (t.fails >= 5) t.until = now + Math.min(30_000 * 2 ** (t.fails - 5), 15 * 60_000);
    this.tries.set(key, t);
  }

  succeeded(key: string): void {
    this.tries.delete(key);
  }
}
