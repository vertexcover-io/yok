import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { notifierHooks } from "@yok/core";
import type { ILogger, IStorage, Result } from "@yok/sdk";
import type { Accounts, ApiToken, GitHubSignIn, User, UserEntry } from "@yok/sdk/internal";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import * as z from "zod";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import {
  DeviceStartBodySchema,
  type DeviceStartReplySchema,
  DeviceTokenBodySchema,
  type DeviceTokenReply,
  readHomeEnv,
  updateHomeEnv,
} from "./protocol.ts";

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";
const SESSION_COOKIE = "yok_session";
const NONCE_COOKIE = "yok_login_nonce";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_POLL_SECONDS = 2;
// POST /api/auth/device is open and the requests live in memory, so they are capped.
export const MAX_PENDING_DEVICE_REQUESTS = 100;
// No vowels and no look-alikes, so a code read off a terminal is typed back without doubt.
const USER_CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
// One grant: who the person is, push and pull on every repo they can reach, and pushes that
// change workflow files, which GitHub refuses without `workflow` (ADR 0041).
// read:org lets /user/orgs list private memberships, which GITHUB_ORGS is checked against.
const GITHUB_SCOPE = "repo workflow read:user user:email read:org";

export type IdentityDeps = Readonly<{
  home: string;
  storage: IStorage;
  // https://SERVER_DOMAIN, else http://localhost:PORT; GitHub sends the browser back here
  publicOrigin: string;
  now: () => Date;
  log: ILogger;
  // SERVER_DOMAIN was set when the server started: only then does a sign-in need an org or a
  // super-admin login
  gated: boolean;
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

const commaList = (value: string | undefined): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");

// Read from .env on each sign-in, so a change needs no restart. GitHub logins and org slugs are
// case-insensitive, so both lists are lowercased.
const readSignInRules = (home: string) => {
  const env = readHomeEnv(home);
  return { admins: commaList(env.SUPER_ADMIN_LOGINS), orgs: commaList(env.GITHUB_ORGS) };
};

// What a gated server says when no one can sign in; undefined when somebody can.
export const missingSignInKeys = (home: string): string | undefined => {
  const { admins, orgs } = readSignInRules(home);
  return admins.length + orgs.length > 0
    ? undefined
    : "No one can sign in yet: set SUPER_ADMIN_LOGINS (GitHub logins) or GITHUB_ORGS (GitHub org slugs), or both, in the yok home's .env";
};

const NOT_SET_UP =
  "GitHub sign-in is not set up: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are missing from the yok home's .env";

const LOCAL_ORIGIN = "http://yok.local";

// Only a path on this server, so a crafted next= cannot send the browser to another site. The URL
// parser drops tabs and newlines and reads a backslash as a slash, as a browser does, so
// `/\evil.com` and `/<tab>/evil.com` resolve off this origin and are refused.
export const safeNext = (next: string | undefined): string => {
  if (next?.startsWith("/") !== true) return "/";
  return URL.canParse(next, LOCAL_ORIGIN) && new URL(next, LOCAL_ORIGIN).origin === LOCAL_ORIGIN
    ? next
    : "/";
};

type GitHubCalls = Pick<IdentityDeps, "githubFetch">;

const githubFetch = (deps: GitHubCalls): notifierHooks.Fetch => deps.githubFetch ?? fetch;

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

const api = (deps: GitHubCalls, token: string, path: string): Promise<Response> =>
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

export type GitHubIdentity = Omit<GitHubSignIn, "token">;

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

const OrgsSchema = z.array(z.looseObject({ login: z.string() }));
const NEXT_PAGE = /<([^>]+)>;\s*rel="next"/;

// Every org slug the account belongs to, lowercased, following GitHub's Link header page by page.
// Private memberships appear only because the grant carries read:org.
const fetchOrgs = async (
  deps: IdentityDeps,
  token: string,
  path = "/user/orgs?per_page=100",
  found: readonly string[] = [],
): Promise<Result<readonly string[]>> => {
  const res = await api(deps, token, path);
  const orgs = OrgsSchema.safeParse(await readJson(res));
  if (!res.ok || !orgs.success)
    return { ok: false, error: "GitHub did not list the account's orgs" };
  const all = [...found, ...orgs.data.map((org) => org.login.toLowerCase())];
  const next = NEXT_PAGE.exec(res.headers.get("link") ?? "")?.[1];
  return next?.startsWith(`${GITHUB_API}/`)
    ? fetchOrgs(deps, token, next.slice(GITHUB_API.length), all)
    : { ok: true, value: all };
};

// A super-admin needs no org, so GitHub is asked for orgs only when the login alone is not enough.
const mayEnter = async (
  deps: IdentityDeps,
  token: string,
  login: string,
): Promise<Result<boolean>> => {
  const { admins, orgs } = readSignInRules(deps.home);
  if (admins.includes(login.toLowerCase())) return { ok: true, value: true };
  if (orgs.length === 0) return { ok: true, value: false };
  const memberOf = await fetchOrgs(deps, token).catch(
    (): Result<readonly string[]> => ({ ok: false, error: "GitHub could not be reached" }),
  );
  return memberOf.ok
    ? { ok: true, value: memberOf.value.some((org) => orgs.includes(org)) }
    : memberOf;
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
export const tokenAlive = async (deps: GitHubCalls, token: string): Promise<boolean> => {
  const res = await api(deps, token, "/user").catch(() => null);
  return res?.status !== 401;
};

// The account stays: dropping its token ends yok's access, not who the person is.
export const dropGitHubToken = async (storage: IStorage, [userId, user]: UserEntry) => {
  const github = user.accounts.github;
  if (github === undefined) return;
  const account = { provider: "github", providerId: String(github.id), username: github.login };
  await storage.users.addUserAccount(userId, account);
};

export type Caller = Readonly<{
  userId: string;
  user: User;
  via: "cookie" | "token";
  // the CLI token that signed the request in; absent for a cookie
  tokenId?: string;
}>;

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const BEARER = /^Bearer\s+(\S+)\s*$/i;

// A user whose access was revoked at sign-in is no caller, however valid the cookie or token.
const activeUser = async (storage: IStorage, userId: string): Promise<User | undefined> => {
  const user = await storage.users.find(userId);
  return user?.accessRevokedAt === undefined ? user : undefined;
};

// Each write takes SQLite's write lock, so a busy CLI stamps its token at most this often.
const TOUCH_AFTER_MS = 5 * 60_000;

const touchStale = async (deps: CallerDeps, token: ApiToken): Promise<void> => {
  const now = deps.now();
  const last = token.lastUsedAt;
  if (last !== null && now.getTime() - Date.parse(last) < TOUCH_AFTER_MS) return;
  await deps.storage.users.touchToken(token.id, now).catch(() => undefined);
};

const callerByToken = async (deps: CallerDeps, token: string): Promise<Caller | undefined> => {
  const found = await deps.storage.users.findToken(hashToken(token));
  if (found === undefined) return undefined;
  const user = await activeUser(deps.storage, found.userId);
  if (user === undefined) return undefined;
  await touchStale(deps, found);
  return { userId: found.userId, user, via: "token", tokenId: found.id };
};

const callerByCookie = async (c: Context, deps: CallerDeps): Promise<Caller | undefined> => {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie === undefined) return undefined;
  const session = verifyValue(await sessionSecret(deps.home), cookie, "session", deps.now());
  if (session === null) return undefined;
  const user = await activeUser(deps.storage, session.sub);
  return user === undefined ? undefined : { userId: session.sub, user, via: "cookie" };
};

export type CallerDeps = Readonly<{
  home: string;
  storage: IStorage;
  now: () => Date;
  // SERVER_DOMAIN was set when the server started
  gated: boolean;
}>;

// What a shared server leaves open without a caller. Slack's signature is the gate of its hook;
// the others are how a person or the CLI gets a credential in the first place.
const OPEN_PATHS: ReadonlySet<string> = new Set([
  "/api/health",
  "/login",
  "/auth/github",
  "/auth/github/callback",
  "/api/hooks/slack",
  "/api/auth/device",
  "/api/auth/device/token",
]);
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const wantsPage = (c: Context): boolean =>
  READ_METHODS.has(c.req.method) && c.req.header("accept")?.includes("text/html") === true;

// A browser navigation goes to sign in; the API and the dashboard's own requests get a 401 they
// can read, including the terminal's upgrade request, which is answered before any upgrade.
const refuse = (c: Context, message: string): Response => {
  if (c.req.path.startsWith("/api/")) return errorResponse(c, 401, "unauthenticated", message);
  if (!wantsPage(c)) return c.text(`unauthenticated: ${message}`, 401);
  const url = new URL(c.req.url);
  return c.redirect(loginRedirect(url.pathname + url.search));
};

// Works out who is calling on every request, so a handler can show a signed-in view on a local
// server too. Only a gated server refuses: no caller, or a cookie caller's change with no Origin
// (hostGuard has already checked an Origin that is sent), is turned away.
export const requireCaller =
  (deps: CallerDeps): MiddlewareHandler<{ Variables: Vars }> =>
  async (c, next) => {
    const bearer = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    const caller =
      bearer === undefined ? await callerByCookie(c, deps) : await callerByToken(deps, bearer);
    c.set("caller", caller);
    if (!deps.gated || OPEN_PATHS.has(c.req.path)) return next();
    if (caller === undefined) return refuse(c, "sign in with yok login, or send a valid token");
    const changes = !READ_METHODS.has(c.req.method);
    if (caller.via === "cookie" && changes && c.req.header("origin") === undefined) {
      return c.text("forbidden: a request that changes something must send an Origin", 403);
    }
    return next();
  };

// For a route that mints or revokes a credential: a token must not be able to make more of itself.
export const cookieOnly: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  if (c.get("caller")?.via === "token") {
    return refuse(c, "this needs a signed-in browser session, not a token");
  }
  return next();
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
input{font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg)}
.token{margin-bottom:12px}
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

const newToken = (): string => `yok_${randomBytes(32).toString("base64url")}`;

type DeviceRequest = Readonly<{
  hostname: string;
  userCode: string;
  expiresAt: number;
  // the person who approved it; the CLI's next poll turns this into a token
  approvedBy?: string;
}>;

// Pending CLI logins by device code. They live in memory: a restart only makes the CLI start again.
type DeviceRequests = Map<string, DeviceRequest>;

const newUserCode = (): string => {
  const letters = Array.from({ length: 8 }, () =>
    USER_CODE_LETTERS.charAt(randomInt(USER_CODE_LETTERS.length)),
  ).join("");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
};

// Typed by hand, so case, spaces and a missing dash do not matter.
const normalizeUserCode = (typed: string): string => {
  const letters = typed.toUpperCase().replace(/[^A-Z]/g, "");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
};

const liveRequests = (requests: DeviceRequests, now: Date): DeviceRequests => {
  for (const [deviceCode, request] of requests) {
    if (request.expiresAt < now.getTime()) requests.delete(deviceCode);
  }
  return requests;
};

const findByUserCode = (requests: DeviceRequests, typed: string) => {
  const userCode = normalizeUserCode(typed);
  return [...requests].find(
    ([, request]) => request.userCode === userCode && request.approvedBy === undefined,
  );
};

const startDevice = (
  c: Context,
  deps: IdentityDeps,
  requests: DeviceRequests,
  hostname: string,
) => {
  if (liveRequests(requests, deps.now()).size >= MAX_PENDING_DEVICE_REQUESTS) {
    return errorResponse(
      c,
      429,
      "too-many-requests",
      "too many login requests are waiting; try again in a few minutes",
    );
  }
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = newUserCode();
  const expiresAt = deps.now().getTime() + DEVICE_TTL_MS;
  requests.set(deviceCode, { hostname, userCode, expiresAt });
  return c.json(
    {
      deviceCode,
      userCode,
      verificationUrl: `${deps.publicOrigin}/device`,
      expiresIn: DEVICE_TTL_MS / 1000,
      interval: DEVICE_POLL_SECONDS,
    } satisfies z.infer<typeof DeviceStartReplySchema>,
    200,
  );
};

const EXPIRED = "this login request expired or was never made; run yok login again";

// The token is minted here and shown once; the entry goes before any await, so two polls at once
// cannot both receive one. A person whose access was revoked since approving gets nothing.
const pollDevice = async (
  c: Context,
  deps: IdentityDeps,
  requests: DeviceRequests,
  deviceCode: string,
) => {
  const request = liveRequests(requests, deps.now()).get(deviceCode);
  if (request === undefined) return errorResponse(c, 404, "not-found", EXPIRED);
  if (request.approvedBy === undefined) {
    return c.json({ status: "pending" } satisfies DeviceTokenReply, 200);
  }
  requests.delete(deviceCode);
  const user = await activeUser(deps.storage, request.approvedBy);
  if (user === undefined) return errorResponse(c, 404, "not-found", EXPIRED);
  const token = newToken();
  await deps.storage.users.createToken(
    request.approvedBy,
    `CLI on ${request.hostname}`,
    hashToken(token),
  );
  return c.json({ status: "approved", token } satisfies DeviceTokenReply, 200);
};

const deviceCodeForm = html`<p class="muted">Type the code the yok CLI printed.</p>
<form method="get" action="/device"><input name="code" autocomplete="off" autofocus required placeholder="ABCD-EFGH"> <button class="primary">Continue</button></form>`;

const unknownCodePage = (c: Context) =>
  c.html(
    page(
      "Code not recognised",
      html`<p>That code is wrong or has expired. Run <code>yok login</code> again for a new one.</p><p><a class="button" href="/device">Enter another code</a></p>`,
    ),
    400,
  );

const deviceConfirmPage = (user: User, request: DeviceRequest) =>
  page(
    "Approve the yok CLI",
    html`<p>Give the yok CLI on <code>${request.hostname}</code> access as ${user.name}?</p>
<p class="muted">Code ${request.userCode}. The access lasts until you revoke it in Settings.</p>
<p>Approve only if you just ran <code>yok login</code> yourself.</p>
<form method="post" action="/device"><input type="hidden" name="code" value="${request.userCode}"><button class="primary">Approve</button></form>`,
  );

const signedInUser = (c: Context<{ Variables: Vars }>): UserEntry | null => {
  const caller = c.get("caller");
  return caller === undefined ? null : [caller.userId, caller.user];
};

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

const revokeQuietly = (deps: IdentityDeps, app: OAuthApp, token: string): Promise<void> =>
  revokeToken(deps, app, token).catch((error: unknown) =>
    deps.log.warn({ err: error }, "GitHub could not be reached to revoke the token"),
  );

// The token just granted is revoked and no user is made. A person yok already knows loses the
// CLI tokens too and is marked, so their cookie and Slack stop working until a later sign-in.
const refuseSignIn = async (
  c: Context,
  deps: IdentityDeps,
  app: OAuthApp,
  token: string,
  identity: GitHubIdentity,
) => {
  await revokeQuietly(deps, app, token);
  const known = await deps.storage.users.findByAccount("github", String(identity.id));
  if (known !== undefined) {
    await deps.storage.users.setAccessRevokedAt(known[0], deps.now().toISOString());
    await deps.storage.users.deleteTokens(known[0]);
  }
  deps.log.info({ login: identity.login }, "sign-in refused");
  return c.html(
    page(
      "Not allowed in",
      html`<p>GitHub account <code>${identity.login}</code> does not belong to one of the GitHub orgs registered on this server, and is not a super-admin.</p><p class="muted">Ask whoever runs this yok server to add your org or your login.</p>`,
    ),
    403,
  );
};

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
    await revokeQuietly(deps, app, token);
    return failed(c, identity.error, 502);
  }
  const missing = deps.gated ? missingSignInKeys(deps.home) : undefined;
  if (missing !== undefined) {
    await revokeQuietly(deps, app, token);
    return failed(c, missing, 503);
  }
  const allowed = deps.gated
    ? await mayEnter(deps, token, identity.value.login)
    : ({ ok: true, value: true } as const);
  if (!allowed.ok) {
    await revokeQuietly(deps, app, token);
    return failed(c, allowed.error, 502);
  }
  if (!allowed.value) return refuseSignIn(c, deps, app, token, identity.value);
  const [userId, user] = await deps.storage.users.saveGitHubUser({ ...identity.value, token });
  if (user.accessRevokedAt !== undefined) await deps.storage.users.setAccessRevokedAt(userId, null);
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

const tokenRow = (token: ApiToken) => {
  const used =
    token.lastUsedAt === null
      ? "Never used"
      : `Last used ${token.lastUsedAt.slice(0, 16).replace("T", " ")} UTC`;
  return html`<div class="token"><code>${token.name}</code> <span class="muted">${used}</span>
<form class="actions" method="post" action="/settings/tokens/${token.id}/revoke"><button>Revoke</button></form></div>`;
};

const tokensRow = (tokens: readonly ApiToken[]) => html`<dd>${
  tokens.length === 0
    ? html`<p class="muted">No tokens yet. yok login adds one for each machine.</p>`
    : tokens.map(tokenRow)
}
<form class="actions" method="post" action="/settings/tokens"><input name="name" placeholder="github actions" maxlength="80" required> <button>Create token</button></form></dd>`;

const settingsPage = ([, user]: UserEntry, tokens: readonly ApiToken[]) =>
  page(
    "Settings",
    html`<dl><dt>Signed in as</dt><dd>${user.name} (GitHub <code>${user.accounts.github?.login ?? "-"}</code>)</dd>
<dt>GitHub access</dt>${githubRow(user.accounts.github)}
<dt>Slack</dt>${slackRow(user.slack)}
<dt>CLI tokens</dt>${tokensRow(tokens)}</dl>
<form class="foot" method="post" action="/logout"><button>Sign out</button></form>`,
  );

// Slack member ids are not secret, so anyone can send a signed-in teammate their own link. The
// page therefore names the Slack member and the yok user and links only on a click, a POST the
// session cookie's SameSite=Lax keeps other sites from sending. The user comes from the session,
// never the URL: the state names only the Slack member.
const linkSlackPage = async (
  c: Context<{ Variables: Vars }>,
  deps: IdentityDeps,
  state: string,
  confirmed: boolean,
) => {
  const signedIn = signedInUser(c);
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
  await deps.storage.users.addUserAccount(userId, { provider: "slack", providerId: signed.sub });
  deps.log.info({ userId, member: signed.sub }, "Slack linked");
  return c.html(
    page(
      "Slack linked",
      html`<p>Slack linked to ${user.name}. You can close this tab.</p><p><a class="button" href="/settings">Settings</a></p>`,
    ),
  );
};

// Mounted at / by createRoot, behind the host guard and requireCaller like the dashboard.
export const identityRoutes = (deps: IdentityDeps) => {
  const requests: DeviceRequests = new Map();
  return (
    new Hono<{ Variables: Vars }>()
      .get("/login", (c) => {
        const next = safeNext(c.req.query("next"));
        if (signedInUser(c) !== null) return c.redirect(next);
        const missing = deps.gated ? missingSignInKeys(deps.home) : undefined;
        if (missing !== undefined) return failed(c, missing, 503);
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
        const signedIn = signedInUser(c);
        if (signedIn === null) return c.redirect(loginRedirect("/settings"));
        return c.html(settingsPage(signedIn, await deps.storage.users.listTokens(signedIn[0])));
      })
      .post("/settings/tokens", cookieOnly, async (c) => {
        const signedIn = signedInUser(c);
        if (signedIn === null) return c.redirect(loginRedirect("/settings"));
        const name = z
          .string()
          .trim()
          .min(1)
          .max(80)
          .safeParse((await c.req.parseBody()).name);
        if (!name.success) {
          return c.html(
            page(
              "Name the token",
              html`<p>A token needs a name, so you can tell it apart later.</p><p><a class="button" href="/settings">Settings</a></p>`,
            ),
            400,
          );
        }
        const token = newToken();
        await deps.storage.users.createToken(signedIn[0], name.data, hashToken(token));
        c.header("Cache-Control", "no-store");
        return c.html(
          page(
            "Token created",
            html`<p>Copy <code>${name.data}</code> now: yok keeps only a hash and cannot show it again.</p><p><code>${token}</code></p><p><a class="button" href="/settings">Settings</a></p>`,
          ),
        );
      })
      .post("/settings/tokens/:id/revoke", cookieOnly, async (c) => {
        const signedIn = signedInUser(c);
        if (signedIn === null) return c.redirect(loginRedirect("/settings"));
        await deps.storage.users.deleteToken(signedIn[0], c.req.param("id"));
        return c.redirect("/settings");
      })
      .post("/api/auth/device", jsonBody(DeviceStartBodySchema), (c) =>
        startDevice(c, deps, requests, c.req.valid("json").hostname),
      )
      .post("/api/auth/device/token", jsonBody(DeviceTokenBodySchema), (c) =>
        pollDevice(c, deps, requests, c.req.valid("json").deviceCode),
      )
      .get("/device", cookieOnly, (c) => {
        const signedIn = signedInUser(c);
        if (signedIn === null) return c.redirect(loginRedirect("/device"));
        const typed = c.req.query("code");
        if (typed === undefined) return c.html(page("Approve the yok CLI", deviceCodeForm));
        const found = findByUserCode(liveRequests(requests, deps.now()), typed);
        return found === undefined
          ? unknownCodePage(c)
          : c.html(deviceConfirmPage(signedIn[1], found[1]));
      })
      .post("/device", cookieOnly, async (c) => {
        const signedIn = signedInUser(c);
        if (signedIn === null) return c.redirect(loginRedirect("/device"));
        const typed = (await c.req.parseBody()).code;
        const found = findByUserCode(
          liveRequests(requests, deps.now()),
          typeof typed === "string" ? typed : "",
        );
        if (found === undefined) return unknownCodePage(c);
        const [deviceCode, request] = found;
        requests.set(deviceCode, { ...request, approvedBy: signedIn[0] });
        deps.log.info({ userId: signedIn[0], hostname: request.hostname }, "CLI login approved");
        return c.html(
          page(
            "yok CLI approved",
            html`<p>The yok CLI on <code>${request.hostname}</code> now has access as ${signedIn[1].name}. Go back to your terminal.</p>`,
          ),
        );
      })
      .post("/logout", (c) => {
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return c.redirect("/login");
      })
      .get("/link/slack", (c) => linkSlackPage(c, deps, c.req.query("state") ?? "", false))
      .post("/link/slack", cookieOnly, async (c) => {
        const body = await c.req.parseBody();
        return linkSlackPage(c, deps, typeof body.state === "string" ? body.state : "", true);
      })
      .post("/settings/slack/unlink", cookieOnly, async (c) => {
        const signedIn = signedInUser(c);
        if (signedIn === null) return c.redirect(loginRedirect("/settings"));
        await deps.storage.users.removeUserAccount(signedIn[0], "slack");
        return c.redirect("/settings");
      })
      // Revoked now, not when the person's runs end: a run holding the token fails its next push,
      // which is what Disconnect asks for.
      .post("/settings/github/disconnect", cookieOnly, async (c) => {
        const signedIn = signedInUser(c);
        if (signedIn === null) return c.redirect(loginRedirect("/settings"));
        const [, user] = signedIn;
        const app = oauthApp(deps.home);
        const token = user.accounts.github?.token;
        if (app !== null && token !== undefined) {
          await revokeToken(deps, app, token).catch((error: unknown) =>
            deps.log.warn({ err: error }, "GitHub could not be reached to revoke the token"),
          );
        }
        await dropGitHubToken(deps.storage, signedIn);
        return c.redirect("/settings");
      })
  );
};
