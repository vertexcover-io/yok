import { Command } from "@commander-js/extra-typings";
import { unwrap } from "@yok/core";
import { type Result, yokHome } from "@yok/sdk";
import { updateHomeEnv } from "@yok/server";
import {
  checkServerUrl,
  ENV_KEYS,
  fail,
  getWithLogin,
  type RemoteSettings,
  WRONG_LOGIN,
} from "./client.ts";

// parseEnv ends an unquoted value at "#", so each value goes inside a quote it does not hold.
// Double quotes come last: inside them parseEnv turns \n into a newline.
const quoteForEnvFile = (value: string): string => {
  const quote = ["'", "`", '"'].find((mark) => !value.includes(mark));
  if (quote === undefined) {
    throw new Error(
      "HOME/.env cannot hold a value with ', ` and \" in it; set it in the shell instead",
    );
  }
  return `${quote}${value}${quote}`;
};

// Saves the login only after the server accepted it, so a typo never replaces a working login.
export const login = async (settings: RemoteSettings, home: string): Promise<string> => {
  unwrap(checkServerUrl(settings.url));
  const url = settings.url.replace(/\/+$/, "");
  const user = quoteForEnvFile(settings.user);
  const password = quoteForEnvFile(settings.password);
  await getWithLogin({ ...settings, url }, "/api/projects", WRONG_LOGIN);
  await updateHomeEnv(home, {
    [ENV_KEYS.url]: url,
    [ENV_KEYS.user]: user,
    [ENV_KEYS.password]: password,
  });
  return `logged in to ${url} as ${settings.user}`;
};

// The variable keeps the password out of the process list; the flag stays for a CI job that
// cannot set it.
export const loginPassword = (
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Result<string> => {
  const password = flag ?? env[ENV_KEYS.password];
  if (password !== undefined) return { ok: true, value: password };
  return {
    ok: false,
    error: "no password: set YOK_SERVER_PASSWORD, or pass --password (visible in ps)",
  };
};

// Only meaningful with --remote; the root's preAction gate refuses it without the flag.
export const loginCommand = () =>
  new Command("login")
    .description("Check a server's login, then save it to HOME/.env (use as yok-remote login)")
    .argument("<url>", "the server's address, e.g. https://yok.example.com")
    .requiredOption("--user <name>", "the username the server's login asks for")
    .option("--password <password>", "the password (default: YOK_SERVER_PASSWORD); visible in ps")
    .action(async (url, { user, password }) => {
      const typed = loginPassword(password, process.env);
      if (!typed.ok) return fail(typed.error);
      console.log(await login({ url, user, password: typed.value }, yokHome()));
    });
