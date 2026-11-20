import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "@yok/sdk";
import { memoryStorage } from "@yok/sdk/internal";
import { Hono } from "hono";
import {
  dropGitHubToken,
  hashToken,
  identityRoutes,
  requireCaller,
  safeNext,
  sessionSecret,
  signValue,
  verifyValue,
} from "./identity.ts";

const SECRET = "s3cret";
const NOW = new Date("2026-11-04T00:00:00Z");
const base = { sub: "", purpose: "login" as const, exp: NOW.getTime() + 60_000 };

describe("signed values", () => {
  test("SC1: a signed value reads back only for its own purpose, unaltered, unexpired and under its own secret", () => {
    const token = signValue(SECRET, base);
    const [payload = "", mac = ""] = token.split(".");
    const edited = Buffer.from(JSON.stringify({ ...base, sub: "u_x" })).toString("base64url");

    expect(verifyValue(SECRET, token, "login", NOW)).toEqual(base);
    expect(verifyValue(SECRET, token, "session", NOW)).toBeNull();
    expect(verifyValue(SECRET, `${edited}.${mac}`, "login", NOW)).toBeNull();
    expect(verifyValue(SECRET, `${payload}.${mac.slice(0, -1)}A`, "login", NOW)).toBeNull();
    expect(verifyValue("other", token, "login", NOW)).toBeNull();
    expect(verifyValue(SECRET, token, "login", new Date(base.exp + 1))).toBeNull();
  });

  test("a MAC of the right length ending in a non-ASCII character reads back as null", () => {
    const [payload = "", mac = ""] = signValue(SECRET, base).split(".");

    expect(verifyValue(SECRET, `${payload}.${mac.slice(0, -1)}é`, "login", NOW)).toBeNull();
  });

  test("sessionSecret called at once on a fresh home gives every caller the secret it saves", async () => {
    const home = mkdtempSync(join(tmpdir(), "identity-"));

    const secrets = await Promise.all([1, 2, 3].map(() => sessionSecret(home)));

    expect(new Set(secrets).size).toBe(1);
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(`YOK_SESSION_SECRET=${secrets[0]}\n`);
  });

  test("SC2: safeNext keeps a path on this server and sends everything else to /", () => {
    expect(safeNext("/settings")).toBe("/settings");
    for (const next of ["//evil.com", "https://evil.com", undefined])
      expect(safeNext(next)).toBe("/");
  });
});

type Call = Readonly<{ url: string; method: string; body: string }>;

const OAUTH_APP = "GITHUB_CLIENT_ID=cid\nGITHUB_CLIENT_SECRET=csecret\n";

const setup = (env = OAUTH_APP, gated = false) => {
  const home = mkdtempSync(join(tmpdir(), "identity-"));
  writeFileSync(join(home, ".env"), env);
  const calls: Call[] = [];
  const github = {
    token: "gho_a",
    name: "Ritesh" as string | null,
    down: false,
    // a reply that replaces GitHub's usual one for that endpoint
    replies: {} as Partial<Record<"token" | "user" | "emails" | "orgs", () => Response>>,
    // the org slugs /user/orgs lists, one array per page
    orgPages: [] as string[][],
  };
  const githubFetch = async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
    if (github.down) throw new TypeError("fetch failed");
    if (url.endsWith("/login/oauth/access_token"))
      return github.replies.token?.() ?? Response.json({ access_token: github.token });
    if (url.includes("/user/orgs")) {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const hasNext = page < github.orgPages.length;
      return (
        github.replies.orgs?.() ??
        Response.json(
          (github.orgPages[page - 1] ?? []).map((login) => ({ login })),
          hasNext
            ? {
                headers: {
                  link: `<https://api.github.com/user/orgs?per_page=100&page=${page + 1}>; rel="next"`,
                },
              }
            : {},
        )
      );
    }
    if (url.endsWith("/user/emails"))
      return (
        github.replies.emails?.() ??
        Response.json([{ email: "r@example.com", primary: true, verified: true }])
      );
    if (url.endsWith("/user"))
      return (
        github.replies.user?.() ??
        Response.json({ id: 8675309, login: "ritesh-gh", name: github.name })
      );
    return new Response(null, { status: 204 });
  };
  let clock = NOW;
  const storage = memoryStorage();
  const now = () => clock;
  const app = new Hono().use("*", requireCaller({ home, storage, now, gated })).route(
    "/",
    identityRoutes({
      home,
      storage,
      publicOrigin: "http://localhost:4000",
      now,
      log: noopLogger,
      githubFetch,
      gated,
    }),
  );
  return { app, home, storage, calls, github, setClock: (at: Date) => (clock = at) };
};

type Setup = ReturnType<typeof setup>;

const cookieOf = (res: Response, name = "yok_session"): string =>
  res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

const startSignIn = async ({ app }: Setup, next = "/settings") => {
  const start = await app.request(`/auth/github?next=${encodeURIComponent(next)}`);
  const authorize = new URL(start.headers.get("location") ?? "");
  return {
    authorize,
    state: authorize.searchParams.get("state") ?? "",
    nonce: cookieOf(start, "yok_login_nonce"),
  };
};

const signIn = async (s: Setup, next = "/settings") => {
  const { authorize, state, nonce } = await startSignIn(s, next);
  const done = await s.app.request(
    `/auth/github/callback?code=c1&state=${encodeURIComponent(state)}`,
    { headers: { cookie: nonce } },
  );
  return { authorize, done };
};

describe("GitHub sign-in", () => {
  test("SC120 (SC4): signing in creates a connected yok user and a session, and revokes nothing", async () => {
    const s = setup();
    const { authorize, done } = await signIn(s);

    expect(authorize.searchParams.get("scope")).toBe("repo workflow read:user user:email read:org");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4000/auth/github/callback",
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/settings");
    const cookie = done.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("yok_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const users = (await s.storage.users.list()).map(([, user]) => user);
    expect(users).toHaveLength(1);
    expect(users[0]?.accounts.github).toEqual({
      id: 8675309,
      login: "ritesh-gh",
      token: "gho_a",
    });
    expect(s.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("SC120 (SC5): signing in again reuses the user, follows GitHub's name and stores the newer token", async () => {
    const s = setup();
    await signIn(s);
    const [[firstId] = [""]] = await s.storage.users.list();
    s.github.token = "gho_b";
    s.github.name = "Ritesh K";
    await signIn(s);

    const users = await s.storage.users.list();
    expect(users.map(([id]) => id)).toEqual([firstId]);
    expect(users[0]?.[1].name).toBe("Ritesh K");
    expect(users[0]?.[1].accounts.github?.token).toBe("gho_b");
    expect(s.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("SC121 (SC6): a callback with a forged or expired state signs nobody in and never calls GitHub", async () => {
    const s = setup();
    const forged = signValue("other-secret", { ...base, exp: NOW.getTime() + 60_000 });
    const expired = (await signIn(s)).authorize.searchParams.get("state") ?? "";
    s.calls.length = 0;
    s.setClock(new Date(NOW.getTime() + 11 * 60_000));
    const before = await s.storage.users.list();

    for (const state of [forged, expired]) {
      const res = await s.app.request(
        `/auth/github/callback?code=c1&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(400);
      expect(cookieOf(res)).toBe("");
    }
    expect(s.calls).toEqual([]);
    expect(await s.storage.users.list()).toEqual(before);
  });

  test("a callback from a browser that did not start the sign-in signs nobody in, and the starting browser's nonce cookie is cleared after one use", async () => {
    const s = setup();
    const { state, nonce } = await startSignIn(s);
    s.calls.length = 0;
    const url = `/auth/github/callback?code=c1&state=${encodeURIComponent(state)}`;

    for (const headers of [{}, { cookie: "yok_login_nonce=someone-else" }]) {
      const res = await s.app.request(url, { headers });
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie") ?? "").not.toContain("yok_session=");
    }
    expect(s.calls).toEqual([]);
    expect(nonce).toStartWith("yok_login_nonce=");

    const done = await s.app.request(url, { headers: { cookie: nonce } });
    expect(done.status).toBe(302);
    const cookies = done.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("yok_session="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("yok_login_nonce=;"))).toBe(true);
  });

  test("SC121: a GitHub reply that is not JSON, at the code exchange or at /user, answers 502, signs nobody in, stores nothing and revokes any token GitHub issued", async () => {
    for (const endpoint of ["token", "user"] as const) {
      const s = setup();
      s.github.replies[endpoint] = () => new Response("<html>busy</html>", { status: 502 });

      const { done } = await signIn(s);

      expect(done.status).toBe(502);
      expect(cookieOf(done)).toBe("");
      expect(await s.storage.users.list()).toEqual([]);
      const revokes = s.calls.filter((call) => call.method === "DELETE");
      expect(revokes.map((call) => JSON.parse(call.body))).toEqual(
        endpoint === "user" ? [{ access_token: "gho_a" }] : [],
      );
    }
  });

  test("SC121: a code exchange with no access_token answers 502, signs nobody in, stores nothing and revokes nothing", async () => {
    const s = setup();
    s.github.replies.token = () => Response.json({ error: "bad_verification_code" });

    const { done } = await signIn(s);

    expect(done.status).toBe(502);
    expect(cookieOf(done)).toBe("");
    expect(await s.storage.users.list()).toEqual([]);
    expect(s.calls.map((call) => call.method)).not.toContain("DELETE");
  });

  test("SC121: a /user reply without the account after a good exchange answers 502, signs nobody in, stores nothing and revokes the token", async () => {
    const s = setup();
    s.github.replies.user = () => Response.json({ message: "Bad credentials" }, { status: 401 });

    const { done } = await signIn(s);

    expect(done.status).toBe(502);
    expect(cookieOf(done)).toBe("");
    expect(await s.storage.users.list()).toEqual([]);
    const revoke = s.calls.find((call) => call.method === "DELETE");
    expect(revoke?.url).toBe("https://api.github.com/applications/cid/token");
    expect(JSON.parse(revoke?.body ?? "{}")).toEqual({ access_token: "gho_a" });
  });

  test("an account with no verified primary email and no name signs in with an empty email and its login as the name", async () => {
    const s = setup();
    s.github.name = null;
    s.github.replies.emails = () =>
      Response.json([{ email: "r@example.com", primary: true, verified: false }]);

    const { done } = await signIn(s);

    expect(done.status).toBe(302);
    const user = (await s.storage.users.list())[0]?.[1];
    expect(user?.email).toBe("");
    expect(user?.name).toBe("ritesh-gh");
  });

  test("SC7: /settings needs a session, then names the signed-in GitHub login", async () => {
    const s = setup();
    const anonymous = await s.app.request("/settings");
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe("/login?next=%2Fsettings");

    const { done } = await signIn(s);
    const page = await s.app.request("/settings", { headers: { cookie: cookieOf(done) } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ritesh-gh");
  });

  test("SC8: sign-in without the OAuth app's id and secret says what is missing", async () => {
    const s = setup("");
    const res = await s.app.request("/auth/github");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("GITHUB_CLIENT_ID");
    expect(text).toContain("GITHUB_CLIENT_SECRET");
  });
});

const setSignInEnv = (home: string, keys: string): void =>
  writeFileSync(join(home, ".env"), OAUTH_APP + keys);

describe("who may sign in on a shared server", () => {
  test("SC10: a login in SUPER_ADMIN_LOGINS, written in another case, signs in without asking GitHub for orgs", async () => {
    const s = setup(`${OAUTH_APP}SUPER_ADMIN_LOGINS=other, Ritesh-GH\n`, true);

    const { done } = await signIn(s);

    expect(done.status).toBe(302);
    expect(cookieOf(done)).toStartWith("yok_session=");
    expect(await s.storage.users.list()).toHaveLength(1);
    expect(s.calls.some((call) => call.url.includes("/user/orgs"))).toBe(false);
  });

  test("SC11: a member of an org in GITHUB_ORGS, written in another case and listed on the second page of /user/orgs, signs in", async () => {
    const s = setup(`${OAUTH_APP}GITHUB_ORGS=Acme,beta\n`, true);
    s.github.orgPages = [["elsewhere"], ["ACME"]];

    const { done } = await signIn(s);

    expect(done.status).toBe(302);
    expect(cookieOf(done)).toStartWith("yok_session=");
    expect(await s.storage.users.list()).toHaveLength(1);
    expect(s.calls.filter((call) => call.url.includes("/user/orgs"))).toHaveLength(2);
  });

  test("SC12: an account that is no super-admin and in no registered org gets a 403 page, its fresh GitHub token is revoked and no user is created", async () => {
    const s = setup(`${OAUTH_APP}SUPER_ADMIN_LOGINS=someone\nGITHUB_ORGS=acme\n`, true);
    s.github.orgPages = [["elsewhere"]];

    const { done } = await signIn(s);

    expect(done.status).toBe(403);
    expect(await done.text()).toContain("registered");
    expect(cookieOf(done)).toBe("");
    expect(await s.storage.users.list()).toEqual([]);
    const revoke = s.calls.find((call) => call.method === "DELETE");
    expect(JSON.parse(revoke?.body ?? "{}")).toEqual({ access_token: "gho_a" });
  });

  test("SC13: a refused sign-in by a known GitHub id sets access_revoked_at, deletes its CLI tokens and ends its old session", async () => {
    const s = setup(`${OAUTH_APP}SUPER_ADMIN_LOGINS=ritesh-gh\n`, true);
    const cookie = cookieOf((await signIn(s)).done);
    const [[userId = ""] = []] = await s.storage.users.list();
    await s.storage.users.createToken(userId, "laptop", hashToken("yok_abc"));
    setSignInEnv(s.home, "SUPER_ADMIN_LOGINS=someone-else\n");

    const { done } = await signIn(s);

    expect(done.status).toBe(403);
    const user = await s.storage.users.find(userId);
    expect(user?.accessRevokedAt).toBe(NOW.toISOString());
    expect(await s.storage.users.listTokens(userId)).toEqual([]);
    expect(await s.storage.users.list()).toHaveLength(1);
    const old = await s.app.request("/settings", { headers: { cookie, accept: "text/html" } });
    expect(old.headers.get("location")).toBe("/login?next=%2Fsettings");
  });

  test("SC14: a revoked user who is later allowed signs in again with access_revoked_at cleared", async () => {
    const s = setup(`${OAUTH_APP}SUPER_ADMIN_LOGINS=ritesh-gh\n`, true);
    await signIn(s);
    const [[userId = ""] = []] = await s.storage.users.list();
    setSignInEnv(s.home, "SUPER_ADMIN_LOGINS=someone-else\n");
    await signIn(s);
    expect((await s.storage.users.find(userId))?.accessRevokedAt).toBeDefined();
    setSignInEnv(s.home, "SUPER_ADMIN_LOGINS=ritesh-gh\n");

    const { done } = await signIn(s);

    expect(done.status).toBe(302);
    expect((await s.storage.users.find(userId))?.accessRevokedAt).toBeUndefined();
    const page = await s.app.request("/settings", { headers: { cookie: cookieOf(done) } });
    expect(page.status).toBe(200);
  });

  test("SC15: a gated server with neither SUPER_ADMIN_LOGINS nor GITHUB_ORGS answers /login naming both keys and offers no GitHub button", async () => {
    const s = setup(OAUTH_APP, true);

    const res = await s.app.request("/login");

    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("SUPER_ADMIN_LOGINS");
    expect(text).toContain("GITHUB_ORGS");
    expect(text).not.toContain("/auth/github?next");
  });

  test("SC16: SUPER_ADMIN_LOGINS edited in .env between two sign-ins decides the second one, with no restart", async () => {
    const s = setup(`${OAUTH_APP}SUPER_ADMIN_LOGINS=ritesh-gh\n`, true);
    expect((await signIn(s)).done.status).toBe(302);
    setSignInEnv(s.home, "SUPER_ADMIN_LOGINS=someone-else\n");

    expect((await signIn(s)).done.status).toBe(403);
  });

  test("a /user/orgs reply GitHub fails answers 502, revokes the token and leaves the known user's access alone", async () => {
    const s = setup(`${OAUTH_APP}GITHUB_ORGS=acme\n`, true);
    s.github.orgPages = [["acme"]];
    await signIn(s);
    const [[userId = ""] = []] = await s.storage.users.list();
    s.github.replies.orgs = () => new Response("busy", { status: 502 });

    const { done } = await signIn(s);

    expect(done.status).toBe(502);
    expect((await s.storage.users.find(userId))?.accessRevokedAt).toBeUndefined();
    expect(s.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });
});

const linkState = async (home: string, member = "U7", exp = NOW.getTime() + 60_000) =>
  signValue(await sessionSecret(home), { sub: member, purpose: "link", exp });

describe("Slack link page", () => {
  test("SC122 (SC14): a signed-in browser opening a link state for U7 is asked to confirm, and confirming links U7 to its user", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const state = await linkState(s.home);
    const headers = { cookie: cookieOf(done) };

    const asked = await s.app.request(`/link/slack?state=${encodeURIComponent(state)}`, {
      headers,
    });

    expect(asked.status).toBe(200);
    const text = await asked.text();
    expect(text).toContain("U7");
    expect(text).toContain("Ritesh");
    expect((await s.storage.users.list())[0]?.[1]?.slack).toBeUndefined();

    const confirmed = await s.app.request("/link/slack", {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state }),
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain("Slack linked to Ritesh");
    expect((await s.storage.users.list())[0]?.[1]?.slack).toBe("U7");
  });

  test("SC122 (SC15): a browser with no session is sent to /login with next= holding the same link, and nothing is linked", async () => {
    const s = setup();
    await signIn(s);
    const before = await s.storage.users.list();
    const path = `/link/slack?state=${encodeURIComponent(await linkState(s.home))}`;

    const res = await s.app.request(path);

    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location") ?? "", "http://localhost:4000");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe(path);
    expect(await s.storage.users.list()).toEqual(before);
  });

  test("SC122 (SC16): a link state with an edited member id, or one past its expiry, gets a 400 asking for @yok login and links nothing", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const [payload = "", mac = ""] = (await linkState(s.home)).split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const edited = Buffer.from(JSON.stringify({ ...claims, sub: "U8" })).toString("base64url");
    const expired = await linkState(s.home, "U7", NOW.getTime() - 1);
    const before = await s.storage.users.list();

    for (const state of [`${edited}.${mac}`, expired]) {
      const res = await s.app.request(`/link/slack?state=${encodeURIComponent(state)}`, {
        headers: { cookie: cookieOf(done) },
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Type @yok login in Slack for a new one");
    }
    expect(await s.storage.users.list()).toEqual(before);
  });

  test("SC122: POST /link/slack with no session links nothing and sends the browser to /login", async () => {
    const s = setup();
    await signIn(s);
    const before = await s.storage.users.list();

    const res = await s.app.request("/link/slack", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: await linkState(s.home) }),
    });

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "", "http://x").pathname).toBe("/login");
    expect(await s.storage.users.list()).toEqual(before);
  });

  test("SC122: POST /link/slack with a forged, expired, missing or non-string state answers 400 and links nothing", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const cookie = cookieOf(done);
    const before = await s.storage.users.list();
    const forged = signValue("other-secret", {
      sub: "U7",
      purpose: "link",
      exp: NOW.getTime() + 60_000,
    });
    const expired = await linkState(s.home, "U7", NOW.getTime() - 1);
    const file = new FormData();
    file.append("state", new Blob([await linkState(s.home)]), "state.txt");
    const bodies: BodyInit[] = [
      new URLSearchParams({ state: forged }),
      new URLSearchParams({ state: expired }),
      new URLSearchParams({}),
      file,
    ];

    for (const body of bodies) {
      const res = await s.app.request("/link/slack", { method: "POST", headers: { cookie }, body });
      expect(res.status).toBe(400);
    }
    expect(await s.storage.users.list()).toEqual(before);
  });

  test("SC122: GET /link/slack with a valid state only asks: the stored users are unchanged", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const before = await s.storage.users.list();

    const res = await s.app.request(
      `/link/slack?state=${encodeURIComponent(await linkState(s.home))}`,
      { headers: { cookie: cookieOf(done) } },
    );

    expect(res.status).toBe(200);
    expect(await s.storage.users.list()).toEqual(before);
  });

  test("SC122: settings shows linked member U7 with Unlink Slack, and unlinking leaves it Not linked", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const headers = { cookie: cookieOf(done) };
    await s.app.request("/link/slack", {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: await linkState(s.home) }),
    });
    expect(await (await s.app.request("/settings", { headers })).text()).toContain(
      "Member <code>U7</code>",
    );

    const unlink = await s.app.request("/settings/slack/unlink", { method: "POST", headers });

    expect(unlink.headers.get("location")).toBe("/settings");
    expect((await s.storage.users.list())[0]?.[1]?.slack).toBeUndefined();
    expect(await (await s.app.request("/settings", { headers })).text()).toContain("Not linked");
  });

  test("a CLI token cannot unlink Slack or disconnect GitHub: those routes take a cookie only", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const userId = (await s.storage.users.list())[0]?.[0] ?? "";
    await s.storage.users.addUserAccount(userId, { provider: "slack", providerId: "U7" });
    await s.storage.users.createToken(userId, "laptop", hashToken("yok_abc"));
    const bearer = { authorization: "Bearer yok_abc" };

    for (const path of ["/settings/slack/unlink", "/settings/github/disconnect"]) {
      const res = await s.app.request(path, { method: "POST", headers: bearer });
      expect([path, res.status]).toEqual([path, 401]);
    }
    expect((await s.storage.users.find(userId))?.slack).toBe("U7");
    expect((await s.storage.users.find(userId))?.accounts.github?.token).toBe("gho_a");
    const unlink = await s.app.request("/settings/slack/unlink", {
      method: "POST",
      headers: { cookie: cookieOf(done) },
    });
    expect(unlink.status).toBe(302);
    expect((await s.storage.users.find(userId))?.slack).toBeUndefined();
  });
});

describe("the identity pages look like the dashboard", () => {
  // Every colour token the dashboard sets, light and dark, as `--name: value` pairs.
  const dashboardTokens = (): string[] =>
    readFileSync(join(import.meta.dir, "runs.html"), "utf8").match(/--[a-z0-9-]+: #[0-9a-f]{6}/g) ??
    [];

  test("sign-in and settings carry the dashboard's colour tokens and its brand bar back to the dashboard", async () => {
    const s = setup();
    const login = await (await s.app.request("/login")).text();
    const headers = { cookie: cookieOf((await signIn(s)).done) };
    const settings = await (await s.app.request("/settings", { headers })).text();

    expect(dashboardTokens().length).toBeGreaterThan(20);
    for (const page of [login, settings]) {
      for (const token of dashboardTokens()) expect(page).toContain(token);
      expect(page).toContain('<a class="brand" href="/">');
    }
  });

  test("the action a page is for is the accent button, and the rest stay quiet", async () => {
    const s = setup();
    const login = await (await s.app.request("/login")).text();
    const headers = { cookie: cookieOf((await signIn(s)).done) };
    const settings = await (await s.app.request("/settings", { headers })).text();

    expect(login).toContain('class="button primary" href="/auth/github?next=%2F"');
    expect(settings).not.toMatch(/class="[^"]*primary/);
    expect(settings).toContain("<button>Sign out</button>");
  });
});

describe("GitHub access in settings", () => {
  test("SC19: settings says Connected as ritesh-gh with Disconnect, and once the connector is gone says Not connected with a Connect GitHub link", async () => {
    const s = setup();
    const headers = { cookie: cookieOf((await signIn(s)).done) };

    const connected = await (await s.app.request("/settings", { headers })).text();
    expect(connected).toContain("Connected as <code>ritesh-gh</code>");
    expect(connected).toContain('action="/settings/github/disconnect"');

    for (const entry of await s.storage.users.list()) await dropGitHubToken(s.storage, entry);
    const disconnected = await (await s.app.request("/settings", { headers })).text();
    expect(disconnected).toContain("Not connected");
    expect(disconnected).toContain('href="/auth/github?next=%2Fsettings"');
  });

  test("the Connect GitHub link renders as one unbroken box, never wrapping across lines", async () => {
    const s = setup();
    const headers = { cookie: cookieOf((await signIn(s)).done) };

    const page = await (await s.app.request("/settings", { headers })).text();

    const rule = page.match(/a\.button\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("display:inline-block");
    expect(rule).toContain("white-space:nowrap");
  });

  test("a name that is one long word wraps inside its row, so a phone never scrolls sideways", async () => {
    const s = setup();
    const headers = { cookie: cookieOf((await signIn(s)).done) };

    const page = await (await s.app.request("/settings", { headers })).text();

    expect(page.match(/dd\{([^}]*)\}/)?.[1]).toContain("overflow-wrap:anywhere");
  });

  test("SC123 (SC20): Disconnect sends gho_a to GitHub's revoke endpoint, drops the GitHub token, keeps the GitHub account and slack, and returns to /settings", async () => {
    const s = setup();
    const headers = { cookie: cookieOf((await signIn(s)).done) };
    for (const [id] of await s.storage.users.list()) {
      await s.storage.users.addUserAccount(id, { provider: "slack", providerId: "U7" });
    }

    const res = await s.app.request("/settings/github/disconnect", { method: "POST", headers });

    const revoke = s.calls.find((call) => call.url.endsWith("/applications/cid/token"));
    expect(revoke?.method).toBe("DELETE");
    expect(JSON.parse(revoke?.body ?? "{}")).toEqual({ access_token: "gho_a" });
    const user = (await s.storage.users.list())[0]?.[1];
    expect(user?.accounts.github).toEqual({ id: 8675309, login: "ritesh-gh" });
    expect(user?.slack).toBe("U7");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings");
  });

  test("SC123 (SC21): Disconnect still drops the GitHub token and returns to /settings when the revoke call throws a network error", async () => {
    const s = setup();
    const headers = { cookie: cookieOf((await signIn(s)).done) };
    s.github.down = true;

    const res = await s.app.request("/settings/github/disconnect", { method: "POST", headers });

    expect((await s.storage.users.list())[0]?.[1]?.accounts.github?.token).toBeUndefined();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings");
  });

  test("SC123 (SC22): Disconnect with no session cookie goes to /login?next=%2Fsettings, leaves the stored users as they were and never calls GitHub", async () => {
    const s = setup();
    await signIn(s);
    const before = await s.storage.users.list();
    const callsBefore = s.calls.length;

    const res = await s.app.request("/settings/github/disconnect", { method: "POST" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fsettings");
    expect(await s.storage.users.list()).toEqual(before);
    expect(s.calls.length).toBe(callsBefore);
  });
});

const FORM = { "content-type": "application/x-www-form-urlencoded" };

const postJson = (s: Setup, path: string, body: unknown) =>
  s.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const startDevice = async (s: Setup, hostname = "ritesh-mbp") => {
  const res = await postJson(s, "/api/auth/device", { hostname });
  return (await res.json()) as { deviceCode: string; userCode: string; verificationUrl: string };
};

const pollDevice = (s: Setup, deviceCode: string) =>
  postJson(s, "/api/auth/device/token", { deviceCode });

const approveDevice = (s: Setup, headers: Record<string, string>, userCode: string) =>
  s.app.request("/device", {
    method: "POST",
    headers: { ...headers, ...FORM },
    body: new URLSearchParams({ code: userCode }),
  });

const signedInHeaders = async (s: Setup) => ({ cookie: cookieOf((await signIn(s)).done) });

describe("CLI device login", () => {
  test("starting a request returns a device code, a user code like ABCD-EFGH and the /device URL", async () => {
    const s = setup();

    const started = await startDevice(s);

    expect(started.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(started.deviceCode.length).toBeGreaterThan(30);
    expect(started.verificationUrl).toBe("http://localhost:4000/device");
  });

  test("SC17: approving the request gives the polling CLI a yok_ token once, keeps only its hash, and a second poll gets nothing", async () => {
    const s = setup();
    const headers = await signedInHeaders(s);
    const { deviceCode, userCode } = await startDevice(s);

    const approved = await approveDevice(s, headers, userCode);
    const first = await pollDevice(s, deviceCode);
    const { token } = (await first.json()) as { token: string };
    const second = await pollDevice(s, deviceCode);

    expect(approved.status).toBe(200);
    expect(first.status).toBe(200);
    expect(token).toMatch(/^yok_[A-Za-z0-9_-]{43}$/);
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    expect((await s.storage.users.listTokens(userId)).map((t) => t.name)).toEqual([
      "CLI on ritesh-mbp",
    ]);
    expect((await s.storage.users.findToken(hashToken(token)))?.userId).toBe(userId);
    expect(await s.storage.users.findToken(token)).toBeUndefined();
    expect(second.status).toBe(404);
    expect(JSON.stringify(await second.json())).not.toContain(token);
  });

  test("SC18: polling before anyone approves answers pending and mints no token", async () => {
    const s = setup();
    await signIn(s);
    const { deviceCode } = await startDevice(s);

    const res = await pollDevice(s, deviceCode);

    expect(await res.json()).toEqual({ status: "pending" });
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    expect(await s.storage.users.listTokens(userId)).toEqual([]);
  });

  test("SC19: a request older than 10 minutes is expired for the poll and for the approval, and a code never issued is the same", async () => {
    const s = setup();
    const headers = await signedInHeaders(s);
    const { deviceCode, userCode } = await startDevice(s);
    s.setClock(new Date(NOW.getTime() + 10 * 60_000 + 1));

    const poll = await pollDevice(s, deviceCode);
    const approve = await approveDevice(s, headers, userCode);
    const unknown = await pollDevice(s, "never-issued");

    expect(poll.status).toBe(404);
    expect(approve.status).toBe(400);
    expect(unknown.status).toBe(404);
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    expect(await s.storage.users.listTokens(userId)).toEqual([]);
  });

  test("SC20: /device with no session cookie goes to sign-in and comes back to /device", async () => {
    const s = setup();

    const res = await s.app.request("/device");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fdevice");
  });

  test("/device asks for the code, then names the machine and the person with an Approve button", async () => {
    const s = setup();
    const headers = await signedInHeaders(s);
    const { userCode } = await startDevice(s, "build-box");

    const ask = await (await s.app.request("/device", { headers })).text();
    const confirm = await (
      await s.app.request(`/device?code=${userCode.toLowerCase().replace("-", "")}`, { headers })
    ).text();
    const wrong = await s.app.request("/device?code=ZZZZ-ZZZZ", { headers });

    expect(ask).toContain('name="code"');
    expect(confirm).toContain("Give the yok CLI on <code>build-box</code> access as Ritesh?");
    expect(confirm).toContain('action="/device"');
    expect(confirm).toContain(`value="${userCode}"`);
    expect(wrong.status).toBe(400);
  });

  test("SC21: approving with a Bearer token instead of a cookie is refused and the request stays pending", async () => {
    const s = setup();
    await signIn(s);
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    await s.storage.users.createToken(userId, "laptop", hashToken("yok_abc"));
    const { deviceCode, userCode } = await startDevice(s);

    const res = await approveDevice(s, { authorization: "Bearer yok_abc" }, userCode);

    expect(res.status).toBe(401);
    expect(await (await pollDevice(s, deviceCode)).json()).toEqual({ status: "pending" });
  });

  test("a person whose access was revoked cannot approve, and a request approved before the revoke mints no token", async () => {
    const s = setup();
    const headers = await signedInHeaders(s);
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    const early = await startDevice(s);
    await approveDevice(s, headers, early.userCode);
    const late = await startDevice(s);
    await s.storage.users.setAccessRevokedAt(userId, NOW.toISOString());

    const approve = await approveDevice(s, headers, late.userCode);
    const poll = await pollDevice(s, early.deviceCode);

    expect(approve.status).toBe(302);
    expect(poll.status).toBe(404);
    expect(await (await pollDevice(s, late.deviceCode)).json()).toEqual({ status: "pending" });
    expect(await s.storage.users.listTokens(userId)).toEqual([]);
  });
});

describe("tokens in settings", () => {
  const createToken = (s: Setup, headers: Record<string, string>, name: string) =>
    s.app.request("/settings/tokens", {
      method: "POST",
      headers: { ...headers, ...FORM },
      body: new URLSearchParams({ name }),
    });

  test("settings lists each token with its last use and a Revoke button", async () => {
    const s = setup();
    const headers = await signedInHeaders(s);
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    const used = await s.storage.users.createToken(userId, "laptop", hashToken("yok_a"));
    await s.storage.users.touchToken(used.id, NOW);
    const idle = await s.storage.users.createToken(userId, "ci", hashToken("yok_b"));

    const page = await (await s.app.request("/settings", { headers })).text();

    expect(page).toContain("<code>laptop</code>");
    expect(page).toContain("Last used 2026-11-04");
    expect(page).toContain("<code>ci</code>");
    expect(page).toContain("Never used");
    expect(page).toContain(`action="/settings/tokens/${idle.id}/revoke"`);
  });

  test("SC22: creating a CI token shows it once, and the database finds it only by its hash", async () => {
    const s = setup();
    const headers = await signedInHeaders(s);

    const res = await createToken(s, headers, "github actions");
    const shown = (await res.text()).match(/yok_[A-Za-z0-9_-]{43}/)?.[0] ?? "";

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    expect((await s.storage.users.listTokens(userId)).map((t) => t.name)).toEqual([
      "github actions",
    ]);
    expect((await s.storage.users.findToken(hashToken(shown)))?.name).toBe("github actions");
    expect(await s.storage.users.findToken(shown)).toBeUndefined();
    const settings = await (await s.app.request("/settings", { headers })).text();
    expect(settings).not.toContain(shown);
  });

  test("a blank name makes no token, and a Bearer token cannot make one", async () => {
    const s = setup();
    const headers = await signedInHeaders(s);
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    await s.storage.users.createToken(userId, "laptop", hashToken("yok_abc"));

    const blank = await createToken(s, headers, "   ");
    const viaToken = await createToken(s, { authorization: "Bearer yok_abc" }, "more");

    expect(blank.status).toBe(400);
    expect(viaToken.status).toBe(401);
    expect(await s.storage.users.listTokens(userId)).toHaveLength(1);
  });

  test("Revoke deletes that token so it stops working, and another person's token id deletes nothing", async () => {
    const s = setup();
    const headers = await signedInHeaders(s);
    const [userId] = (await s.storage.users.list())[0] ?? [""];
    const mine = await s.storage.users.createToken(userId, "laptop", hashToken("yok_mine"));
    const other = await s.storage.users.saveGitHubUser({
      id: 2,
      login: "bo",
      name: "Bo",
      email: "",
      token: "gho_b",
    });
    const theirs = await s.storage.users.createToken(
      other[0],
      "bo-laptop",
      hashToken("yok_theirs"),
    );

    const foreign = await s.app.request(`/settings/tokens/${theirs.id}/revoke`, {
      method: "POST",
      headers,
    });
    const own = await s.app.request(`/settings/tokens/${mine.id}/revoke`, {
      method: "POST",
      headers,
    });

    expect(foreign.status).toBe(302);
    expect(own.headers.get("location")).toBe("/settings");
    expect(await s.storage.users.findToken(hashToken("yok_mine"))).toBeUndefined();
    expect(await s.storage.users.findToken(hashToken("yok_theirs"))).toBeDefined();
  });
});
