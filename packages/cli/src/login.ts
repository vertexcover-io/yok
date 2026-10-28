import { Command } from "@commander-js/extra-typings";
import { unwrap } from "@yok/core";
import { yokHome } from "@yok/sdk";
import { updateHomeEnv } from "@yok/server";
import {
  checkServerUrl,
  ENV_KEYS,
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

// Reads one line from a terminal without echoing it, so the password stays out of the process
// list and the shell history.
const promptHidden = (label: string): Promise<string> =>
  new Promise((resolve) => {
    const { stdin } = process;
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let typed = "";
    const onData = (chunk: string): void => {
      for (const key of chunk) {
        if (key === "\u0003") process.exit(130);
        if (key === "\r" || key === "\n" || key === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(typed);
          return;
        }
        typed = key === "\u007f" ? typed.slice(0, -1) : typed + key;
      }
    };
    stdin.on("data", onData);
  });

const readPassword = async (): Promise<string> =>
  process.stdin.isTTY ? promptHidden("Password: ") : Bun.stdin.text();

// --password stays for CI; otherwise YOK_SERVER_PASSWORD, then stdin or a hidden prompt.
export const loginPassword = async (
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  ask: () => Promise<string> = readPassword,
): Promise<string> => flag ?? env[ENV_KEYS.password] ?? (await ask()).replace(/\r?\n$/, "");

// Only meaningful with --remote; the root's preAction gate refuses it without the flag.
export const loginCommand = () =>
  new Command("login")
    .description("Check a server's login, then save it to HOME/.env (use as yok-remote login)")
    .argument("<url>", "the server's address, e.g. https://yok.example.com")
    .requiredOption("--user <name>", "the username the server's login asks for")
    .option(
      "--password <password>",
      "the password (default: YOK_SERVER_PASSWORD, stdin, or a hidden prompt); visible in ps, for CI",
    )
    .action(async (url, { user, password }) => {
      const typed = await loginPassword(password, process.env);
      console.log(await login({ url, user, password: typed }, yokHome()));
    });
