import { hostname as machineName } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "@commander-js/extra-typings";
import { unwrap } from "@yok/core";
import { yokHome } from "@yok/sdk";
import {
  DeviceStartReplySchema,
  DeviceTokenReplySchema,
  ErrorBodySchema,
  updateHomeEnv,
} from "@yok/server";
import { createYokClient } from "@yok/server/client";
import type * as z from "zod";
import {
  checkServerUrl,
  ENV_KEYS,
  OLD_PASSWORD_KEYS,
  openForPerson,
  remoteSettings,
} from "./client.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const EXPIRED = "the login was not approved in time; run yok login again";
const TOKEN_PATH = "/api/auth/device/token";

const postJson = async <S extends z.ZodType>(
  url: string,
  path: string,
  body: unknown,
  schema: S,
): Promise<z.output<S>> => {
  const host = new URL(url).host;
  const reply = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  if (reply === null) throw new Error(`${host} is not answering`);
  // Only the poll knows the code: a code the server has forgotten is a login that expired.
  if (reply.status === 404 && path === TOKEN_PATH) throw new Error(EXPIRED);
  const json: unknown = await reply.json().catch(() => null);
  const refused = ErrorBodySchema.safeParse(json);
  if (!reply.ok && refused.success) throw new Error(`${host}: ${refused.data.error.message}`);
  const parsed = schema.safeParse(json);
  if (!reply.ok || !parsed.success) {
    throw new Error(`${host} answered ${path} with ${reply.status}; is it a yok server?`);
  }
  return parsed.data;
};

// The server hands the token over once, after the person approves; it says how long to wait.
const waitForToken = async (
  url: string,
  start: z.output<typeof DeviceStartReplySchema>,
): Promise<string> => {
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    const reply = await postJson(
      url,
      TOKEN_PATH,
      { deviceCode: start.deviceCode },
      DeviceTokenReplySchema,
    );
    if (reply.status === "approved") return reply.token;
    await sleep(start.interval * 1000);
  }
  throw new Error(EXPIRED);
};

type LoginOptions = Readonly<{
  url: string;
  home: string;
  hostname: string;
  // where the person approves; called once, before the polling starts
  onVerification: (verification: Readonly<{ url: string; userCode: string }>) => void;
}>;

// Saves the login only after the server accepted the token, so a failed login never replaces a
// working one.
export const login = async ({
  url: given,
  home,
  hostname,
  onVerification,
}: LoginOptions): Promise<string> => {
  unwrap(checkServerUrl(given));
  const url = given.replace(/\/+$/, "");
  const start = await postJson(url, "/api/auth/device", { hostname }, DeviceStartReplySchema);
  onVerification({ url: start.verificationUrl, userCode: start.userCode });
  const token = await waitForToken(url, start);
  const unauthenticated = "the server did not accept the new token";
  const me = await createYokClient({ url, token, unauthenticated }).me();
  if (!me.ok) throw new Error(me.error.message);
  if (me.value.user === null) throw new Error(unauthenticated);
  await updateHomeEnv(home, {
    [ENV_KEYS.url]: url,
    [ENV_KEYS.token]: token,
    ...Object.fromEntries(OLD_PASSWORD_KEYS.map((key) => [key, null])),
  });
  return `logged in to ${url} as ${me.value.user.login ?? me.value.user.name}`;
};

// The URL stays, so the next login only needs yok login --server. A token the server no longer
// knows is already revoked, so it is dropped too; a server that does not answer keeps it.
export const logout = async (home: string): Promise<string> => {
  const { url, token } = remoteSettings({}, home);
  const revoked = await createYokClient({ url, token }).revokeCurrentToken();
  if (!revoked.ok && revoked.error.code !== "unauthenticated") {
    throw new Error(`${new URL(url).host}: ${revoked.error.message}`);
  }
  await updateHomeEnv(home, { [ENV_KEYS.token]: null });
  return `logged out of ${url}`;
};

export const loginCommand = () =>
  new Command("login")
    .description("Sign in to a shared server in the browser, then save its login to HOME/.env")
    .requiredOption("--server <url>", "the server's address, e.g. https://yok.example.com")
    .option("--no-open", "print the page's address without opening it")
    .action(async ({ server, open }) => {
      const done = await login({
        url: server,
        home: yokHome(),
        hostname: machineName(),
        onVerification: ({ url, userCode }) => {
          const page = `${url}?code=${userCode}`;
          console.log(`Open ${page} and approve the code ${userCode}`);
          openForPerson(page, !open);
        },
      });
      console.log(done);
    });

export const logoutCommand = () =>
  new Command("logout")
    .description("Revoke this machine's login on the server and remove its token from HOME/.env")
    .action(async () => {
      console.log(await logout(yokHome()));
    });
