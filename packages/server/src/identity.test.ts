import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "@yok/sdk";
import { readUsers, setAccountToken, updateUsers } from "@yok/sdk/internal";
import { Hono } from "hono";
import {
  identityRoutes,
  safeNext,
  sessionSecret,
  signInUser,
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

const setup = (env = "GITHUB_CLIENT_ID=cid\nGITHUB_CLIENT_SECRET=csecret\n") => {
  const home = mkdtempSync(join(tmpdir(), "identity-"));
  writeFileSync(join(home, ".env"), env);
  const calls: Call[] = [];
  const github = {
    token: "gho_a",
    name: "Ritesh" as string | null,
    down: false,
    // a reply that replaces GitHub's usual one for that endpoint
    replies: {} as Partial<Record<"token" | "user" | "emails", () => Response>>,
  };
  const githubFetch = async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
    if (github.down) throw new TypeError("fetch failed");
    if (url.endsWith("/login/oauth/access_token"))
      return github.replies.token?.() ?? Response.json({ access_token: github.token });
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
  const app = new Hono().route(
    "/",
    identityRoutes({
      home,
      publicOrigin: "http://localhost:4000",
      now: () => clock,
      log: noopLogger,
      githubFetch,
    }),
  );
  return { app, home, calls, github, setClock: (at: Date) => (clock = at) };
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
  test("SC4: signing in creates a connected yok user and a session, and revokes nothing", async () => {
    const s = setup();
    const { authorize, done } = await signIn(s);

    expect(authorize.searchParams.get("scope")).toBe("repo read:user user:email");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4000/auth/github/callback",
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/settings");
    const cookie = done.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("yok_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const users = Object.values(await readUsers(s.home));
    expect(users).toHaveLength(1);
    expect(users[0]?.accounts.github).toEqual({
      id: 8675309,
      login: "ritesh-gh",
      token: "gho_a",
    });
    expect(s.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(statSync(join(s.home, "users.json")).mode & 0o777).toBe(0o600);
  });

  test("SC5: signing in again reuses the user, follows GitHub's name and stores the newer token", async () => {
    const s = setup();
    await signIn(s);
    const [firstId] = Object.keys(await readUsers(s.home));
    s.github.token = "gho_b";
    s.github.name = "Ritesh K";
    await signIn(s);

    const users = await readUsers(s.home);
    expect(Object.keys(users)).toEqual([firstId ?? ""]);
    expect(users[firstId ?? ""]?.name).toBe("Ritesh K");
    expect(users[firstId ?? ""]?.accounts.github?.token).toBe("gho_b");
    expect(s.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("two first sign-ins of one GitHub account at once make one yok user, and both get its id", async () => {
    const home = mkdtempSync(join(tmpdir(), "identity-"));
    const identity = { id: 42, login: "octo", name: "Octo", email: "" };

    const ids = await Promise.all([
      signInUser(home, identity, "gho_1"),
      signInUser(home, identity, "gho_2"),
    ]);

    expect(Object.keys(await readUsers(home))).toEqual([ids[0]]);
    expect(ids[1]).toBe(ids[0]);
  });

  test("SC6: a callback with a forged or expired state signs nobody in and never calls GitHub", async () => {
    const s = setup();
    const forged = signValue("other-secret", { ...base, exp: NOW.getTime() + 60_000 });
    const expired = (await signIn(s)).authorize.searchParams.get("state") ?? "";
    s.calls.length = 0;
    s.setClock(new Date(NOW.getTime() + 11 * 60_000));
    const before = readFileSync(join(s.home, "users.json"), "utf8");

    for (const state of [forged, expired]) {
      const res = await s.app.request(
        `/auth/github/callback?code=c1&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(400);
      expect(cookieOf(res)).toBe("");
    }
    expect(s.calls).toEqual([]);
    expect(readFileSync(join(s.home, "users.json"), "utf8")).toBe(before);
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

  test("a GitHub reply that is not JSON, at the code exchange or at /user, answers 502, signs nobody in, stores nothing and revokes any token GitHub issued", async () => {
    for (const endpoint of ["token", "user"] as const) {
      const s = setup();
      s.github.replies[endpoint] = () => new Response("<html>busy</html>", { status: 502 });

      const { done } = await signIn(s);

      expect(done.status).toBe(502);
      expect(cookieOf(done)).toBe("");
      expect(existsSync(join(s.home, "users.json"))).toBe(false);
      const revokes = s.calls.filter((call) => call.method === "DELETE");
      expect(revokes.map((call) => JSON.parse(call.body))).toEqual(
        endpoint === "user" ? [{ access_token: "gho_a" }] : [],
      );
    }
  });

  test("a code exchange with no access_token answers 502, signs nobody in, stores nothing and revokes nothing", async () => {
    const s = setup();
    s.github.replies.token = () => Response.json({ error: "bad_verification_code" });

    const { done } = await signIn(s);

    expect(done.status).toBe(502);
    expect(cookieOf(done)).toBe("");
    expect(existsSync(join(s.home, "users.json"))).toBe(false);
    expect(s.calls.map((call) => call.method)).not.toContain("DELETE");
  });

  test("a /user reply without the account after a good exchange answers 502, signs nobody in, stores nothing and revokes the token", async () => {
    const s = setup();
    s.github.replies.user = () => Response.json({ message: "Bad credentials" }, { status: 401 });

    const { done } = await signIn(s);

    expect(done.status).toBe(502);
    expect(cookieOf(done)).toBe("");
    expect(existsSync(join(s.home, "users.json"))).toBe(false);
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
    const user = Object.values(await readUsers(s.home))[0];
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

const linkState = async (home: string, member = "U7", exp = NOW.getTime() + 60_000) =>
  signValue(await sessionSecret(home), { sub: member, purpose: "link", exp });

describe("Slack link page", () => {
  test("SC14: a signed-in browser opening a link state for U7 is asked to confirm, and confirming links U7 to its user", async () => {
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
    expect(Object.values(await readUsers(s.home))[0]?.slack).toBeUndefined();

    const confirmed = await s.app.request("/link/slack", {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state }),
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain("Slack linked to Ritesh");
    expect(Object.values(await readUsers(s.home))[0]?.slack).toBe("U7");
  });

  test("SC15: a browser with no session is sent to /login with next= holding the same link, and nothing is linked", async () => {
    const s = setup();
    await signIn(s);
    const before = readFileSync(join(s.home, "users.json"), "utf8");
    const path = `/link/slack?state=${encodeURIComponent(await linkState(s.home))}`;

    const res = await s.app.request(path);

    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location") ?? "", "http://localhost:4000");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("next")).toBe(path);
    expect(readFileSync(join(s.home, "users.json"), "utf8")).toBe(before);
  });

  test("SC16: a link state with an edited member id, or one past its expiry, gets a 400 asking for @yok login and links nothing", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const [payload = "", mac = ""] = (await linkState(s.home)).split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const edited = Buffer.from(JSON.stringify({ ...claims, sub: "U8" })).toString("base64url");
    const expired = await linkState(s.home, "U7", NOW.getTime() - 1);
    const before = readFileSync(join(s.home, "users.json"), "utf8");

    for (const state of [`${edited}.${mac}`, expired]) {
      const res = await s.app.request(`/link/slack?state=${encodeURIComponent(state)}`, {
        headers: { cookie: cookieOf(done) },
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Type @yok login in Slack for a new one");
    }
    expect(readFileSync(join(s.home, "users.json"), "utf8")).toBe(before);
  });

  test("POST /link/slack with no session links nothing and sends the browser to /login", async () => {
    const s = setup();
    await signIn(s);
    const before = readFileSync(join(s.home, "users.json"), "utf8");

    const res = await s.app.request("/link/slack", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: await linkState(s.home) }),
    });

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "", "http://x").pathname).toBe("/login");
    expect(readFileSync(join(s.home, "users.json"), "utf8")).toBe(before);
  });

  test("POST /link/slack with a forged, expired, missing or non-string state answers 400 and links nothing", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const cookie = cookieOf(done);
    const before = readFileSync(join(s.home, "users.json"), "utf8");
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
    expect(readFileSync(join(s.home, "users.json"), "utf8")).toBe(before);
  });

  test("GET /link/slack with a valid state only asks: users.json is unchanged", async () => {
    const s = setup();
    const { done } = await signIn(s);
    const before = readFileSync(join(s.home, "users.json"), "utf8");

    const res = await s.app.request(
      `/link/slack?state=${encodeURIComponent(await linkState(s.home))}`,
      { headers: { cookie: cookieOf(done) } },
    );

    expect(res.status).toBe(200);
    expect(readFileSync(join(s.home, "users.json"), "utf8")).toBe(before);
  });

  test("settings shows linked member U7 with Unlink Slack, and unlinking leaves it Not linked", async () => {
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
    expect(Object.values(await readUsers(s.home))[0]?.slack).toBeUndefined();
    expect(await (await s.app.request("/settings", { headers })).text()).toContain("Not linked");
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

    await updateUsers(s.home, (users) =>
      Object.keys(users).reduce((all, id) => setAccountToken(all, id, "github", undefined), users),
    );
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

  test("SC20: Disconnect sends gho_a to GitHub's revoke endpoint, drops the GitHub token, keeps the GitHub account and slack, and returns to /settings", async () => {
    const s = setup();
    const headers = { cookie: cookieOf((await signIn(s)).done) };
    await updateUsers(s.home, (users) =>
      Object.fromEntries(Object.entries(users).map(([id, user]) => [id, { ...user, slack: "U7" }])),
    );

    const res = await s.app.request("/settings/github/disconnect", { method: "POST", headers });

    const revoke = s.calls.find((call) => call.url.endsWith("/applications/cid/token"));
    expect(revoke?.method).toBe("DELETE");
    expect(JSON.parse(revoke?.body ?? "{}")).toEqual({ access_token: "gho_a" });
    const user = Object.values(await readUsers(s.home))[0];
    expect(user?.accounts.github).toEqual({ id: 8675309, login: "ritesh-gh" });
    expect(user?.slack).toBe("U7");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings");
  });

  test("SC21: Disconnect still drops the GitHub token and returns to /settings when the revoke call throws a network error", async () => {
    const s = setup();
    const headers = { cookie: cookieOf((await signIn(s)).done) };
    s.github.down = true;

    const res = await s.app.request("/settings/github/disconnect", { method: "POST", headers });

    expect(Object.values(await readUsers(s.home))[0]?.accounts.github?.token).toBeUndefined();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings");
  });

  test("SC22: Disconnect with no session cookie goes to /login?next=%2Fsettings, leaves users.json as it was and never calls GitHub", async () => {
    const s = setup();
    await signIn(s);
    const before = readFileSync(join(s.home, "users.json"), "utf8");
    const callsBefore = s.calls.length;

    const res = await s.app.request("/settings/github/disconnect", { method: "POST" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fsettings");
    expect(readFileSync(join(s.home, "users.json"), "utf8")).toBe(before);
    expect(s.calls.length).toBe(callsBefore);
  });
});
