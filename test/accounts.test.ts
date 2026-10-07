import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../server/config.ts";
import { createContext } from "../server/context.ts";
import { Accounts, SignInThrottle } from "../server/accounts.ts";
import { Libraries, SharedOcr } from "../server/libraries.ts";
import type { OcrEngine } from "../server/ingest/ocr.ts";
import { buildApp } from "../server/app.ts";
import { importFixture } from "./helpers.ts";

const PW = "correct horse battery";

async function server() {
  const dir = mkdtempSync(join(tmpdir(), "smart-reading-accounts-"));
  const cfg = loadConfig({ libraryDir: dir, embeddings: "off" });
  const accounts = new Accounts(dir);
  const libraries = new Libraries(cfg, { embedder: null, ocr: null });
  const app = await buildApp({ accounts, libraries });
  return {
    dir,
    cfg,
    accounts,
    libraries,
    app,
    cleanup: async () => {
      await app.close();
      await libraries.closeAll();
      accounts.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0];

async function signIn(app: FastifyInstance, username: string, password = PW) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

describe("accounts", () => {
  let cleanup = async () => {};
  afterEach(async () => cleanup());

  it("asks for an owner once, and nothing is readable before signing in", async () => {
    const s = await server();
    cleanup = s.cleanup;
    expect((await s.app.inject("/api/auth/session")).json()).toEqual({ accounts: true, setupNeeded: true, account: null });
    expect((await s.app.inject("/api/documents")).statusCode).toBe(401);
    expect((await s.app.inject("/api/search?q=x")).statusCode).toBe(401);

    const setup = await s.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "ana", password: PW } });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().account).toMatchObject({ username: "ana", isAdmin: true });
    expect(String(setup.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Strict/);

    const again = await s.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "eve", password: PW } });
    expect(again.statusCode).toBe(409);

    const cookie = cookieOf(setup);
    const me = (await s.app.inject({ url: "/api/auth/session", headers: { cookie } })).json();
    expect(me).toMatchObject({ setupNeeded: false, account: { username: "ana" } });
    expect((await s.app.inject({ url: "/api/documents", headers: { cookie } })).json()).toEqual([]);
  });

  it("keeps each person's library to themselves", async () => {
    const s = await server();
    cleanup = s.cleanup;
    const ana = await s.accounts.create("ana", PW, true);
    const ben = await s.accounts.create("ben", PW);
    const docId = await importFixture(s.libraries.forUser(ana.id), "attention-budget.pdf");
    const anaCookie = await signIn(s.app, "ana");
    const benCookie = await signIn(s.app, "BEN"); // names are not case-sensitive

    const unit = await s.app.inject({
      method: "POST",
      url: "/api/units",
      headers: { cookie: anaCookie },
      payload: { type: "quote", docId, page: 2, selectionText: "Attention is a scarce resource." },
    });
    expect(unit.statusCode).toBe(200);

    const anaSees = (await s.app.inject({ url: "/api/search?q=attention", headers: { cookie: anaCookie } })).json();
    expect(anaSees.passages.length).toBeGreaterThan(0);
    expect(anaSees.saved.units.length).toBe(1);

    const get = (url: string) => s.app.inject({ url, headers: { cookie: benCookie } });
    expect((await get("/api/documents")).json()).toEqual([]);
    expect((await get(`/api/documents/${docId}`)).statusCode).toBe(404);
    expect((await get(`/api/documents/${docId}/file`)).statusCode).toBe(404);
    expect((await get("/api/units")).json()).toEqual([]);
    const benSees = (await get("/api/search?q=attention")).json();
    expect(benSees.passages).toEqual([]);
    expect(benSees.saved.units).toEqual([]);
    expect(benSees.files).toEqual([]);
    expect(s.libraries.dirOf(ana.id)).not.toBe(s.libraries.dirOf(ben.id));
  });

  it("slows down password guessing and does not say which part was wrong", async () => {
    const s = await server();
    cleanup = s.cleanup;
    await s.accounts.create("ana", PW, true);
    const wrongName = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "nobody", password: PW } });
    const wrongPw = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ana", password: "nope nope nope" } });
    expect(wrongName.statusCode).toBe(401);
    expect(wrongPw.json().error).toBe(wrongName.json().error);
    for (let i = 0; i < 4; i++) await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ana", password: "x" } });
    const blocked = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ana", password: PW } });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    const t = new SignInThrottle();
    for (let i = 0; i < 5; i++) t.failed("k", 0);
    expect(t.wait("k", 0)).toBe(30_000);
    expect(t.wait("k", 30_000)).toBe(0);
    t.failed("k", 30_000);
    expect(t.wait("k", 30_000)).toBe(60_000);
  });

  it("only the owner manages accounts, and removing one deletes that library", async () => {
    const s = await server();
    cleanup = s.cleanup;
    await s.accounts.create("ana", PW, true);
    const owner = await signIn(s.app, "ana");
    const created = await s.app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner }, payload: { username: "ben", password: PW } });
    expect(created.statusCode).toBe(200);
    const benId = created.json().id as number;
    expect((await s.app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner }, payload: { username: "ben", password: PW } })).statusCode).toBe(409);
    expect((await s.app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner }, payload: { username: "cy", password: "short" } })).statusCode).toBe(400);

    const ben = await signIn(s.app, "ben");
    expect((await s.app.inject({ url: "/api/accounts", headers: { cookie: ben } })).statusCode).toBe(403);
    expect((await s.app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: ben }, payload: { username: "eve", password: PW } })).statusCode).toBe(403);
    await s.app.inject({ url: "/api/documents", headers: { cookie: ben } });
    expect(existsSync(s.libraries.dirOf(benId))).toBe(true);

    const unconfirmed = await s.app.inject({ method: "DELETE", url: `/api/accounts/${benId}`, headers: { cookie: owner } });
    expect(unconfirmed.statusCode).toBe(400);
    const removed = await s.app.inject({ method: "DELETE", url: `/api/accounts/${benId}?confirm=ben`, headers: { cookie: owner } });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(s.libraries.dirOf(benId))).toBe(false);
    expect((await s.app.inject({ url: "/api/documents", headers: { cookie: ben } })).statusCode).toBe(401);
    const self = await s.app.inject({ method: "DELETE", url: "/api/accounts/1?confirm=ana", headers: { cookie: owner } });
    expect(self.statusCode).toBe(400);
  });

  it("changing a password signs out other devices; signing out ends the session", async () => {
    const s = await server();
    cleanup = s.cleanup;
    await s.accounts.create("ana", PW, true);
    const laptop = await signIn(s.app, "ana");
    const phone = await signIn(s.app, "ana");
    const wrong = await s.app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: laptop }, payload: { current: "nope", next: "a much better one" } });
    expect(wrong.statusCode).toBe(403);
    const ok = await s.app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: laptop }, payload: { current: PW, next: "a much better one" } });
    expect(ok.statusCode).toBe(200);
    expect((await s.app.inject({ url: "/api/documents", headers: { cookie: phone } })).statusCode).toBe(401);
    expect((await s.app.inject({ url: "/api/documents", headers: { cookie: laptop } })).statusCode).toBe(200);
    await signIn(s.app, "ana", "a much better one");

    await s.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: laptop } });
    expect((await s.app.inject({ url: "/api/documents", headers: { cookie: laptop } })).statusCode).toBe(401);
  });

  it("refuses writes sent from another website", async () => {
    const s = await server();
    cleanup = s.cleanup;
    await s.accounts.create("ana", PW, true);
    const cookie = await signIn(s.app, "ana");
    const evil = await s.app.inject({
      method: "POST",
      url: "/api/collections",
      headers: { cookie, origin: "https://evil.example", host: "reading.local:4177" },
      payload: { name: "x", query: "y" },
    });
    expect(evil.statusCode).toBe(403);
    const same = await s.app.inject({
      method: "POST",
      url: "/api/collections",
      headers: { cookie, origin: "http://reading.local:4177", host: "reading.local:4177" },
      payload: { name: "x", query: "y" },
    });
    expect(same.statusCode).toBe(200);
  });

  it("one OCR worker serves every library, one page at a time, and a library closing does not stop it", async () => {
    let running = 0;
    let most = 0;
    let closed = 0;
    const engine: OcrEngine = {
      async recognize(_png, size, language) {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (language === "bad") throw new Error("boom");
        return { width: size.width, height: size.height, blocks: [] };
      },
      async close() {
        closed++;
      },
    };
    const shared = new SharedOcr(engine);
    const a = shared.view();
    const b = shared.view();
    const size = { width: 1, height: 1 };
    const results = await Promise.allSettled([a.recognize(Buffer.alloc(0), size, "eng"), b.recognize(Buffer.alloc(0), size, "bad"), b.recognize(Buffer.alloc(0), size, "deu")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(most).toBe(1);
    await a.close();
    expect(closed).toBe(0);
    await shared.close();
    expect(closed).toBe(1);
  });

  it("a library from before accounts becomes the owner's, unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smart-reading-legacy-"));
    const cfg = loadConfig({ libraryDir: dir, embeddings: "off" });
    const old = createContext(cfg, { embedder: null, ocr: null });
    await importFixture(old, "attention-budget.pdf");
    old.db.close();

    const accounts = new Accounts(dir);
    const libraries = new Libraries(cfg, { embedder: null, ocr: null });
    const app = await buildApp({ accounts, libraries });
    cleanup = async () => {
      await app.close();
      await libraries.closeAll();
      accounts.close();
      rmSync(dir, { recursive: true, force: true });
    };
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "ana", password: PW } });
    const docs = (await app.inject({ url: "/api/documents", headers: { cookie: cookieOf(setup) } })).json();
    expect(docs.map((d: { title: string }) => d.title)).toEqual(["The Attention Budget"]);
    expect(existsSync(join(dir, "library.db"))).toBe(false);
    const file = await app.inject({ url: `/api/documents/${docs[0].id}/file`, headers: { cookie: cookieOf(setup) } });
    expect(file.statusCode).toBe(200);
  });
});
