import { Command } from "@commander-js/extra-typings";
import { DoctorReportSchema, unwrap } from "@yok/core";
import { type JsonObject, yokHome } from "@yok/sdk";
import { parsePolicyFlags, VERSION } from "@yok/sdk/internal";
import { readHomeEnv, updateHomeEnv } from "@yok/server";
import { createYokClient, type YokClient } from "@yok/server/client";
import * as z from "zod";
import { apiErrorText, checkServerUrl, cliLog, fail } from "./client.ts";
import { exitCodeFor, renderJson, renderText } from "./doctor.ts";
import { renderProjects } from "./project.ts";
import { addPolicyOptions, collectInput, startError } from "./run.ts";
import { describeFire, describeSchedule, describeTrigger } from "./trigger.ts";

const ENV_KEYS = {
  url: "YOK_SERVER_URL",
  user: "YOK_SERVER_USER",
  password: "YOK_SERVER_PASSWORD",
} as const;

export type RemoteSettings = Readonly<Record<keyof typeof ENV_KEYS, string>>;

const REQUEST_TIMEOUT_MS = 10_000;
const WRONG_LOGIN = "wrong username or password";

// All three come from the shell when it sets YOK_SERVER_URL, else all three from HOME/.env, so a
// shell password is never sent to the saved server and a CI job needs no login.
export const remoteSettings = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): RemoteSettings => {
  const source = env[ENV_KEYS.url] ? env : readHomeEnv(home);
  const settings = {
    url: source[ENV_KEYS.url] ?? "",
    user: source[ENV_KEYS.user] ?? "",
    password: source[ENV_KEYS.password] ?? "",
  };
  const missing = Object.values(ENV_KEYS).filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} not set; run yok remote login URL --user USER`);
  }
  unwrap(checkServerUrl(settings.url));
  return { ...settings, url: settings.url.replace(/\/+$/, "") };
};

// The typed client folds every failure into one ApiError, and login and the health check need
// the status itself: Caddy answers 401 for a wrong login and 502 when yok is down.
const getWithLogin = async (
  { url, user, password }: RemoteSettings,
  path: string,
  wrongLogin: string,
): Promise<Response> => {
  const host = new URL(url).host;
  const basic = Buffer.from(`${user}:${password}`).toString("base64");
  const reply = await fetch(`${url}${path}`, {
    headers: { authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  if (reply === null || reply.status === 502) throw new Error(`${host} is not answering`);
  if (reply.status === 401) throw new Error(wrongLogin);
  if (reply.ok) return reply;
  const text = (await reply.text().catch(() => "")).trim().slice(0, 200);
  throw new Error(`${host} answered ${path} with ${reply.status}${text === "" ? "" : `: ${text}`}`);
};

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

const HealthSchema = z.object({ pid: z.number(), version: z.string(), startedAt: z.number() });

type Remote = Readonly<{ client: YokClient; url: string; health: z.infer<typeof HealthSchema> }>;

// Every remote command but login starts here. It never starts a server, which needs the server's
// own machine. A version mismatch only warns, since most releases change no routes.
const connect = async (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Promise<Remote> => {
  const settings = remoteSettings(env, home);
  const reply = await getWithLogin(
    settings,
    "/api/health",
    `${WRONG_LOGIN}; run yok remote login again`,
  );
  const health = HealthSchema.safeParse(await reply.json().catch(() => null));
  if (!health.success) {
    throw new Error(`${new URL(settings.url).host} did not answer /api/health as a yok server`);
  }
  if (health.data.version !== VERSION) {
    console.error(`warning: this CLI is ${VERSION}, the server is ${health.data.version}`);
  }
  const { url, user, password } = settings;
  const client = createYokClient({ url, login: { user, password }, log: cliLog() });
  return { client, url, health: health.data };
};

const PROJECT_FLAG = "--project <name>";

export const remoteCommand = () => {
  const command = new Command("remote").description(
    "Use the yok server on another machine, through the https login in front of it",
  );

  command
    .command("login")
    .description("Check a server's login, then save it to HOME/.env")
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

  const run = command
    .command("run")
    .description("Start a run on the server, and print its id and dashboard link")
    .argument("<workflow>", "shipped workflow name (e.g. task), or a workflow file in the project")
    .requiredOption("--prompt <text>", "first message sent to the agent")
    .requiredOption(PROJECT_FLAG, "the server's project to run on")
    .option("--name <name>", "run name (default: derived from the prompt)")
    .option("--input <key=value>", "extra input, repeatable", collectInput, {})
    .option("--config <file>", "orchestrate config file in the project (default: the project's)")
    .action(async (workflow, opts) => {
      const cliPolicies = parsePolicyFlags(opts);
      if (!cliPolicies.ok) return fail(cliPolicies.error);
      const { client } = await connect(process.env, yokHome());
      const started = await client.run({
        project: opts.project,
        workflow,
        inputs: { prompt: opts.prompt, ...opts.input } satisfies JsonObject,
        // Nobody sits at a remote run's terminal, so by default no stage waits for an answer.
        policies: { interaction: false, ...cliPolicies.value },
        ...(opts.name === undefined ? {} : { name: opts.name }),
        ...(opts.config === undefined ? {} : { config: opts.config }),
      });
      if (!started.ok) return fail(startError(started.error));
      console.log(`${started.value.run.id}\nview: ${started.value.view}`);
    });
  addPolicyOptions(run);

  const projects = command.command("project").description("Manage the server's projects");

  projects
    .command("list")
    .description("List the server's projects")
    .option("--json", "print the reply as JSON")
    .action(async ({ json }) => {
      const { client } = await connect(process.env, yokHome());
      const listed = await client.projects();
      if (!listed.ok) return fail(apiErrorText(listed.error));
      if (json === true) return console.log(JSON.stringify(listed.value, null, 2));
      const { projects } = listed.value;
      console.log(
        projects.length === 0
          ? "no projects; add one with yok remote project add"
          : renderProjects(projects),
      );
    });

  projects
    .command("add")
    .description("Add a checkout already on the server, or clone one there")
    .argument("<name>", "project name")
    .option("--git <url>", "clone this repository (https or ssh)")
    .option("--path <dir>", "a folder on the server, or where --git clones to; sent as typed")
    .action(async (name, opts) => {
      const { client } = await connect(process.env, yokHome());
      const added = await client.addProject({
        name,
        ...(opts.git === undefined ? {} : { git: opts.git }),
        ...(opts.path === undefined ? {} : { path: opts.path }),
        addedBy: { channel: "cli" },
      });
      if (!added.ok) return fail(apiErrorText(added.error));
      console.log(`added ${added.value.project.name}  ${added.value.project.path}`);
    });

  projects
    .command("remove")
    .description("Forget a project; --purge also deletes a folder yok cloned")
    .argument("<name>", "project name")
    .option("--purge", "delete the folder too, when yok cloned it")
    .action(async (name, opts) => {
      const { client } = await connect(process.env, yokHome());
      const removed = await client.removeProject(name, opts.purge === true);
      if (!removed.ok) return fail(apiErrorText(removed.error));
      console.log(`removed ${removed.value.removed}`);
      if (removed.value.note !== null) console.log(removed.value.note);
    });

  command
    .command("doctor")
    .description("Check a project on the server, and a workflow on it")
    .requiredOption(PROJECT_FLAG, "the server's project to check")
    .option("--workflow <name|path>", "also run the checks this workflow declares")
    .option("--json", "print the report as JSON")
    .action(async ({ project, workflow, json }) => {
      const { client } = await connect(process.env, yokHome());
      const checked = await client.doctor({
        project,
        ...(workflow === undefined ? {} : { workflow }),
      });
      if (!checked.ok) return fail(apiErrorText(checked.error));
      const report = DoctorReportSchema.parse(checked.value.report);
      console.log(json === true ? renderJson(report) : renderText(report));
      process.exitCode = exitCodeFor(report);
    });

  const triggers = command.command("trigger").description("Manage the server's cron triggers");

  triggers
    .command("add")
    .description("Register the workflow's trigger on the server, or update it")
    .argument("<workflow>", "workflow with a trigger: block: a shipped name or a project file")
    .requiredOption(PROJECT_FLAG, "the server's project the trigger's runs start in")
    .option("--config <file>", "orchestrate config file in the project (default: the project's)")
    .action(async (workflow, { project, config }) => {
      const { client } = await connect(process.env, yokHome());
      const added = await client.addTrigger({
        project,
        workflow,
        ...(config === undefined ? {} : { config }),
      });
      if (!added.ok) return fail(apiErrorText(added.error));
      console.log(describeSchedule(added.value.trigger));
    });

  triggers
    .command("list")
    .description("Show every trigger on the server with its next and last fire")
    .action(async () => {
      const { client } = await connect(process.env, yokHome());
      const listed = await client.listTriggers();
      if (!listed.ok) return fail(apiErrorText(listed.error));
      for (const entry of listed.value.triggers) console.log(describeTrigger(entry));
    });

  triggers
    .command("fire")
    .description("Fire the trigger now, as its schedule would")
    .argument("<name>", "trigger name: the workflow's name")
    .requiredOption(PROJECT_FLAG, "the trigger's project")
    .action(async (name, { project }) => {
      const { client } = await connect(process.env, yokHome());
      const fired = await client.fireTrigger({ project, name });
      if (!fired.ok) return fail(apiErrorText(fired.error));
      const { fire } = fired.value;
      if (fire.status === "failed") return fail(describeFire(fire));
      console.log(describeFire(fire));
    });

  triggers
    .command("log")
    .description("Show the trigger's last 20 firings")
    .argument("<name>", "trigger name: the workflow's name")
    .requiredOption(PROJECT_FLAG, "the trigger's project")
    .action(async (name, { project }) => {
      const { client } = await connect(process.env, yokHome());
      const logged = await client.triggerLog({ project, name });
      if (!logged.ok) return fail(apiErrorText(logged.error));
      for (const fire of logged.value.fires) console.log(describeFire(fire));
    });

  triggers
    .command("rm")
    .description("Stop firing the trigger")
    .argument("<name>", "trigger name: the workflow's name")
    .requiredOption(PROJECT_FLAG, "the trigger's project")
    .action(async (name, { project }) => {
      const { client } = await connect(process.env, yokHome());
      const removed = await client.removeTrigger({ project, name });
      if (!removed.ok) return fail(apiErrorText(removed.error));
      console.log(`removed ${name} from ${project}`);
    });

  command
    .command("status")
    .description("Show the server's address and version, its pid and start time, and this CLI's")
    .action(async () => {
      const { url, health } = await connect(process.env, yokHome());
      console.log(
        [
          `server   ${url}`,
          `cli      ${VERSION}`,
          `version  ${health.version}`,
          `pid      ${health.pid}`,
          `started  ${new Date(health.startedAt).toISOString()}`,
        ].join("\n"),
      );
    });

  return command;
};
