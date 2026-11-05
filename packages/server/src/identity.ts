import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { notifierHooks } from "@yok/core";
import type { ILogger, Result } from "@yok/sdk";
import {
  type Accounts,
  findUserByGitHub,
  linkSlack,
  readUsers,
  setAccountToken,
  type UserEntry,
  unlinkSlack,
  updateUsers,
} from "@yok/sdk/internal";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import * as z from "zod";
import { readHomeEnv, updateHomeEnv } from "./protocol.ts";

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";
const SESSION_COOKIE = "yok_session";
const NONCE_COOKIE = "yok_login_nonce";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// One grant: who the person is, and push and pull on every repo they can reach (ADR 0041).
const GITHUB_SCOPE = "repo read:user user:email";

export type IdentityDeps = Readonly<{
  home: string;
  // https://SERVER_DOMAIN, else http://localhost:PORT; GitHub sends the browser back here
  publicOrigin: string;
  now: () => Date;
  log: ILogger;
  // what calls github.com; the network's fetch unless a test answers for GitHub
  githubFetch?: notifierHooks.Fetch | undefined;
}>;

const SignedSchema = z.strictObject({
  // a yok user id, or a Slack member id for purpose link; empty for login
  sub: z.string(),
  purpose: z.enum(["session", "login", "link"]),
  // the path the browser returns to once the flow ends
  next: z.string().optional(),
  // for login: matches the nonce cookie of the browser that started the sign-in
  nonce: z.string().optional(),
  // milliseconds since the epoch
  exp: z.number(),
});
export type Signed = z.infer<typeof SignedSchema>;

const mac = (secret: string, payload: string): string =>
  createHmac("sha256", secret).update(payload).digest("base64url");

// Readable, not encrypted: it carries ids, not secrets. The MAC stops anyone changing them.
export const signValue = (secret: string, value: Signed): string => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
};

// The MAC is checked before the payload is parsed, so attacker-chosen JSON never reaches the parser.
export const verifyValue = (
  secret: string,
  token: string,
  purpose: Signed["purpose"],
  now: Date,
): Signed | null => {
  const [payload, sent, ...rest] = token.split(".");
  if (payload === undefined || sent === undefined || rest.length > 0) return null;
  const expected = Buffer.from(mac(secret, payload));
  const received = Buffer.from(sent);
  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;
  const parsed = SignedSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString()));
  if (!parsed.success || parsed.data.purpose !== purpose) return null;
  return parsed.data.exp > now.getTime() ? parsed.data : null;
};

export const sessionSecret = async (home: string): Promise<string> => {
  const saved = readHomeEnv(home).YOK_SESSION_SECRET;
  if (saved) return saved;
  await updateHomeEnv(
    home,
    (env): Record<string, string> =>
      env.YOK_SESSION_SECRET ? {} : { YOK_SESSION_SECRET: randomBytes(32).toString("hex") },
  );
  const secret = readHomeEnv(home).YOK_SESSION_SECRET;
  if (!secret) throw new Error(`YOK_SESSION_SECRET could not be saved in ${home}/.env`);
  return secret;
};

type OAuthApp = Readonly<{ clientId: string; clientSecret: string }>;

const oauthApp = (home: string): OAuthApp | null => {
  const env = readHomeEnv(home);
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};

const NOT_SET_UP =
  "GitHub sign-in is not set up: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are missing from the yok home's .env";

// Only a path on this server, so a crafted next= cannot send the browser to another site.
export const safeNext = (next: string | undefined): string =>
  next?.startsWith("/") === true && !next.startsWith("//") ? next : "/";

const githubFetch = (deps: IdentityDeps): notifierHooks.Fetch => deps.githubFetch ?? fetch;

// A reply that is not JSON (an outage page) reads as null, which every schema here refuses.
const readJson = (res: Response): Promise<unknown> => res.json().catch(() => null);

const TokenReplySchema = z.looseObject({ access_token: z.string().optional() });

export const exchangeCode = async (
  deps: IdentityDeps,
  app: OAuthApp,
  code: string,
): Promise<Result<string>> => {
  const res = await githubFetch(deps)(`${GITHUB}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
  });
  const token = TokenReplySchema.safeParse(await readJson(res)).data?.access_token;
  return token
    ? { ok: true, value: token }
    : { ok: false, error: "GitHub refused the sign-in code" };
};

const api = (deps: IdentityDeps, token: string, path: string): Promise<Response> =>
  githubFetch(deps)(`${GITHUB_API}${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
  });

const GitHubUserSchema = z.looseObject({
  id: z.number().int(),
  login: z.string(),
  name: z.string().nullable(),
});
const EmailsSchema = z.array(
  z.looseObject({ email: z.string(), primary: z.boolean(), verified: z.boolean() }),
);

export type GitHubIdentity = Readonly<{ id: number; login: string; name: string; email: string }>;

export const fetchIdentity = async (
  deps: IdentityDeps,
  token: string,
): Promise<Result<GitHubIdentity>> => {
  const user = GitHubUserSchema.safeParse(await readJson(await api(deps, token, "/user")));
  if (!user.success) return { ok: false, error: "GitHub did not return the account" };
  const emails = EmailsSchema.safeParse(await readJson(await api(deps, token, "/user/emails")));
  const primary = emails.data?.find((entry) => entry.primary && entry.verified)?.email ?? "";
  const { id, login, name } = user.data;
  return { ok: true, value: { id, login, name: name || login, email: primary } };
};

// GitHub keeps a token valid until it is revoked, so a token yok will not keep is revoked now.
export const revokeToken = async (
  deps: IdentityDeps,
  app: OAuthApp,
  token: string,
): Promise<void> => {
  const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
  const res = await githubFetch(deps)(`${GITHUB_API}/applications/${app.clientId}/token`, {
    method: "DELETE",
    headers: { Accept: "application/vnd.github+json", Authorization: `Basic ${basic}` },
    body: JSON.stringify({ access_token: token }),
  });
  if (!res.ok) deps.log.warn({ status: res.status }, "GitHub did not revoke the token");
};

// Only a 401 means the person revoked it; an outage must not disconnect anyone.
export const tokenAlive = async (deps: IdentityDeps, token: string): Promise<boolean> => {
  const res = await api(deps, token, "/user").catch(() => null);
  return res?.status !== 401;
};

const newUserId = (): string => `u_${randomBytes(4).toString("hex")}`;

// The same GitHub account always maps to the same yok user; its name, email and login follow
// GitHub's on every sign-in, and the sign-in's token becomes its GitHub connector.
export const signInUser = async (
  home: string,
  identity: GitHubIdentity,
  token: string,
): Promise<string> => {
  const after = await updateUsers(home, (users) => {
    const id = findUserByGitHub(users, identity.id)?.[0] ?? newUserId();
    const current = users[id];
    return {
      ...users,
      [id]: {
        ...current,
        name: identity.name,
        email: identity.email,
        accounts: {
          ...current?.accounts,
          github: { id: identity.id, login: identity.login, token },
        },
      },
    };
  });
  // the callback above put this GitHub account in the file, so it is always found
  return findUserByGitHub(after, identity.id)?.[0] ?? "";
};

export const sessionUser = async (c: Context, deps: IdentityDeps): Promise<UserEntry | null> => {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie === undefined) return null;
  const session = verifyValue(await sessionSecret(deps.home), cookie, "session", deps.now());
  if (session === null) return null;
  const user = (await readUsers(deps.home))[session.sub];
  return user === undefined ? null : [session.sub, user];
};

// The dashboard's tokens (runs.html), so these pages read as the same product in light and dark.
const THEME = `:root {
  --bg: #f4f6f5; --panel: #ffffff; --panel-2: #edf1ef; --line: #d9e0dc;
  --fg: #18211d; --muted: #5a6862; --accent: #1d6b62; --accent-fg: #ffffff; --accent-soft: #d9eeea;
  --del: #b2362d; --del-soft: #fbe2df;
  --ok: #2d7a32; --ok-soft: #e0f1e1; --info: #2b5ca4; --info-soft: #e0eaf8; --warn: #915f00; --warn-soft: #faeed3;
  --ui: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1412; --panel: #161d1a; --panel-2: #1c2521; --line: #29342f;
    --fg: #e1eae6; --muted: #92a29b; --accent: #5cc0b2; --accent-fg: #0c1714; --accent-soft: #173330;
    --del: #f07f75; --del-soft: #3b1d1a;
    --ok: #79c97d; --ok-soft: #1a321e; --info: #8bb2f2; --info-soft: #1a2740; --warn: #e7b65c; --warn-soft: #3a2d12;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1412; --panel: #161d1a; --panel-2: #1c2521; --line: #29342f;
  --fg: #e1eae6; --muted: #92a29b; --accent: #5cc0b2; --accent-fg: #0c1714; --accent-soft: #173330;
  --del: #f07f75; --del-soft: #3b1d1a;
  --ok: #79c97d; --ok-soft: #1a321e; --info: #8bb2f2; --info-soft: #1a2740; --warn: #e7b65c; --warn-soft: #3a2d12;
  color-scheme: dark;
}`;

const STYLE = `*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--ui)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:var(--accent)}
.bar{display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.01em;color:inherit;text-decoration:none}
.brand-mark{width:18px;height:18px;border-radius:4px;background:var(--accent);position:relative}
.brand-mark::after{content:"";position:absolute;inset:5px 4px;border-top:2px solid var(--accent-fg);border-bottom:2px solid var(--accent-fg)}
main{max-width:480px;margin:0 auto;padding:48px 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:24px}
h1{margin:0 0 16px;font-size:18px;font-weight:600}
p{margin:0 0 16px}p:last-child{margin-bottom:0}
.muted{color:var(--muted)}
code{font-family:var(--mono);font-size:12.5px;background:var(--panel-2);padding:1px 6px;border-radius:4px}
dl{margin:0}
dt{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 4px}
dd{margin:0 0 20px;overflow-wrap:anywhere}
form{margin:0}.actions{margin-top:10px}
button,a.button{font:inherit;font-size:13px;font-weight:500;padding:6px 14px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block;white-space:nowrap}
button:hover,a.button:hover{background:var(--panel-2)}
a.button.primary,button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
a.button.primary:hover,button.primary:hover{filter:brightness(1.08)}
.foot{margin-top:4px;padding-top:16px;border-top:1px solid var(--line)}`;

const page = (title: string, body: ReturnType<typeof html>) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · yok</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${raw(THEME)}
${raw(STYLE)}</style></head>
<body><header class="bar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>yok</a></header>
<main><section class="card"><h1>${title}</h1>${body}</section></main></body></html>`;

const loginRedirect = (path: string): string => `/login?next=${encodeURIComponent(path)}`;

// The browser is sent to GitHub with a signed state naming why, and comes back to one callback.
export const authorizeUrl = async (
  deps: IdentityDeps,
  app: OAuthApp,
  state: Omit<Signed, "exp">,
  scope: string,
): Promise<string> => {
  const signed = signValue(await sessionSecret(deps.home), {
    ...state,
    exp: deps.now().getTime() + STATE_TTL_MS,
  });
  const query = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: `${deps.publicOrigin}/auth/github/callback`,
    scope,
    state: signed,
  });
  return `${GITHUB}/login/oauth/authorize?${query}`;
};

const startSession = async (c: Context, deps: IdentityDeps, userId: string): Promise<void> => {
  const exp = deps.now().getTime() + SESSION_TTL_MS;
  const value = signValue(await sessionSecret(deps.home), { sub: userId, purpose: "session", exp });
  setCookie(c, SESSION_COOKIE, value, {
    path: "/",
    httpOnly: true,
    // Lax, so the cookie still rides the top-level redirect back from github.com
    sameSite: "Lax",
    secure: deps.publicOrigin.startsWith("https://"),
    maxAge: SESSION_TTL_MS / 1000,
  });
};

const failed = (c: Context, message: string, status: 400 | 502 | 503 = 400) =>
  c.html(
    page(
      "Something went wrong",
      html`<p>${message}</p><p><a class="button primary" href="/login">Sign in again</a></p>`,
    ),
    status,
  );

const finishLogin = async (
  c: Context,
  deps: IdentityDeps,
  app: OAuthApp,
  token: string,
  next: string,
) => {
  const identity = await fetchIdentity(deps, token).catch(
    (): Result<GitHubIdentity> => ({ ok: false, error: "GitHub could not be reached" }),
  );
  if (!identity.ok) {
    await revokeToken(deps, app, token).catch((error: unknown) =>
      deps.log.warn({ err: error }, "GitHub could not be reached to revoke the token"),
    );
    return failed(c, identity.error, 502);
  }
  const userId = await signInUser(deps.home, identity.value, token);
  await startSession(c, deps, userId);
  deps.log.info({ userId, login: identity.value.login }, "signed in");
  return c.redirect(safeNext(next));
};

const callback = async (c: Context, deps: IdentityDeps) => {
  const app = oauthApp(deps.home);
  if (app === null) return failed(c, NOT_SET_UP, 503);
  const secret = await sessionSecret(deps.home);
  const state = verifyValue(secret, c.req.query("state") ?? "", "login", deps.now());
  const nonce = getCookie(c, NONCE_COOKIE);
  deleteCookie(c, NONCE_COOKIE, { path: "/auth/github" });
  if (state === null || nonce === undefined || state.nonce !== nonce) {
    return failed(
      c,
      "This sign-in link expired, was changed or was started in another browser. Start again.",
    );
  }
  const code = c.req.query("code");
  if (code === undefined) return failed(c, "GitHub sent no sign-in code. Start again.");
  const token = await exchangeCode(deps, app, code);
  if (!token.ok) return failed(c, token.error, 502);
  return finishLogin(c, deps, app, token.value, state.next ?? "/");
};

const slackRow = (slack: string | undefined) =>
  slack === undefined
    ? html`<dd>Not linked. Type <code>@yok login</code> in the yok Slack channel to link it.</dd>`
    : html`<dd>Member <code>${slack}</code>
<form class="actions" method="post" action="/settings/slack/unlink"><button>Unlink Slack</button></form></dd>`;

const githubRow = (account: Accounts["github"]) =>
  account?.token === undefined
    ? html`<dd>Not connected: runs you start cannot push or open pull requests.
<div class="actions"><a class="button primary" href="/auth/github?next=%2Fsettings">Connect GitHub</a></div></dd>`
    : html`<dd>Connected as <code>${account.login}</code>: your runs push and open pull requests as you, on every repository you can reach.
<form class="actions" method="post" action="/settings/github/disconnect"><button>Disconnect GitHub</button></form></dd>`;

const settingsPage = ([, user]: UserEntry) =>
  page(
    "Settings",
    html`<dl><dt>Signed in as</dt><dd>${user.name} (GitHub <code>${user.accounts.github?.login ?? "-"}</code>)</dd>
<dt>GitHub access</dt>${githubRow(user.accounts.github)}
<dt>Slack</dt>${slackRow(user.slack)}</dl>
<form class="foot" method="post" action="/logout"><button>Sign out</button></form>`,
  );

// Slack member ids are not secret, so anyone can send a signed-in teammate their own link. The
// page therefore names the Slack member and the yok user and links only on a click, a POST the
// session cookie's SameSite=Lax keeps other sites from sending. The user comes from the session,
// never the URL: the state names only the Slack member.
const linkSlackPage = async (c: Context, deps: IdentityDeps, state: string, confirmed: boolean) => {
  const signedIn = await sessionUser(c, deps);
  const url = new URL(c.req.url);
  if (signedIn === null) {
    return c.redirect(loginRedirect(`${url.pathname}?state=${encodeURIComponent(state)}`));
  }
  const secret = await sessionSecret(deps.home);
  const signed = verifyValue(secret, state, "link", deps.now());
  if (signed === null) {
    return failed(c, "This link expired or was changed. Type @yok login in Slack for a new one.");
  }
  const [userId, user] = signedIn;
  if (!confirmed) {
    return c.html(
      page(
        "Link Slack",
        html`<p>Link Slack member <code>${signed.sub}</code> to ${user.name}? Runs that member starts in Slack will push as you. Only continue if you typed <code>@yok login</code> in Slack.</p>
<form method="post" action="/link/slack"><input type="hidden" name="state" value="${state}"><button class="primary">Link Slack</button></form>`,
      ),
    );
  }
  await updateUsers(deps.home, (users) => linkSlack(users, userId, signed.sub));
  deps.log.info({ userId, member: signed.sub }, "Slack linked");
  return c.html(
    page(
      "Slack linked",
      html`<p>Slack linked to ${user.name}. You can close this tab.</p><p><a class="button" href="/settings">Settings</a></p>`,
    ),
  );
};

// Mounted at / by createRoot, behind the host guard and Caddy's password like the dashboard.
export const identityRoutes = (deps: IdentityDeps) =>
  new Hono()
    .get("/login", async (c) => {
      const next = safeNext(c.req.query("next"));
      if ((await sessionUser(c, deps)) !== null) return c.redirect(next);
      const start = `/auth/github?next=${encodeURIComponent(next)}`;
      return c.html(
        page(
          "Sign in to yok",
          html`<p class="muted">yok uses your GitHub account to show who started each run, and to push and open pull requests for the runs you start from Slack.</p>
<p><a class="button primary" href="${start}">Sign in with GitHub</a></p>`,
        ),
      );
    })
    .get("/auth/github", async (c) => {
      const app = oauthApp(deps.home);
      if (app === null) return failed(c, NOT_SET_UP, 503);
      const next = safeNext(c.req.query("next"));
      // Ties the callback to this browser, so a callback URL someone else started cannot sign
      // this browser in as them.
      const nonce = randomBytes(16).toString("hex");
      setCookie(c, NONCE_COOKIE, nonce, {
        path: "/auth/github",
        httpOnly: true,
        sameSite: "Lax",
        secure: deps.publicOrigin.startsWith("https://"),
        maxAge: STATE_TTL_MS / 1000,
      });
      return c.redirect(
        await authorizeUrl(deps, app, { sub: "", purpose: "login", next, nonce }, GITHUB_SCOPE),
      );
    })
    .get("/auth/github/callback", (c) => callback(c, deps))
    .get("/settings", async (c) => {
      const signedIn = await sessionUser(c, deps);
      return signedIn === null
        ? c.redirect(loginRedirect("/settings"))
        : c.html(settingsPage(signedIn));
    })
    .post("/logout", (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.redirect("/login");
    })
    .get("/link/slack", (c) => linkSlackPage(c, deps, c.req.query("state") ?? "", false))
    .post("/link/slack", async (c) => {
      const body = await c.req.parseBody();
      return linkSlackPage(c, deps, typeof body.state === "string" ? body.state : "", true);
    })
    .post("/settings/slack/unlink", async (c) => {
      const signedIn = await sessionUser(c, deps);
      if (signedIn === null) return c.redirect(loginRedirect("/settings"));
      await updateUsers(deps.home, (users) => unlinkSlack(users, signedIn[0]));
      return c.redirect("/settings");
    })
    // Revoked now, not when the person's runs end: a run holding the token fails its next push,
    // which is what Disconnect asks for.
    .post("/settings/github/disconnect", async (c) => {
      const signedIn = await sessionUser(c, deps);
      if (signedIn === null) return c.redirect(loginRedirect("/settings"));
      const [userId, user] = signedIn;
      const app = oauthApp(deps.home);
      const token = user.accounts.github?.token;
      if (app !== null && token !== undefined) {
        await revokeToken(deps, app, token).catch((error: unknown) =>
          deps.log.warn({ err: error }, "GitHub could not be reached to revoke the token"),
        );
      }
      await updateUsers(deps.home, (users) => setAccountToken(users, userId, "github", undefined));
      return c.redirect("/settings");
    });
