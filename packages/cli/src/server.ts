import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { yokHome } from "@yok/sdk";
import { startServer, updateHomeEnv } from "@yok/server";
import { createYokClient } from "@yok/server/client";
import {
  apiErrorText,
  checkServerUrl,
  cliLog,
  commandLog,
  configuredServerUrl,
  fail,
  runningServer,
  stopServer,
  yokClient,
} from "./client.ts";

const parsePort = (text: string): number => {
  const port = Number(text);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  throw new InvalidArgumentError(`--port must be a port number, got "${text}"`);
};

// One request checks the URL and the key before .env is touched.
const useRemote = async (home: string, url: string, apiKey: string): Promise<void> => {
  const checked = checkServerUrl(url);
  if (!checked.ok) return fail(checked.error);
  const listed = await createYokClient({ url, apiKey, log: cliLog() }).projects();
  if (!listed.ok) return fail(`${url}: ${apiErrorText(listed.error)}`);
  await updateHomeEnv(home, { YOK_SERVER_URL: url, YOK_API_KEY: apiKey });
  console.log(`using ${url}, ${listed.value.projects.length} projects`);
};

const refuseWhenConfigured = (home: string): boolean => {
  const configured = configuredServerUrl(home);
  if (configured === null) return false;
  fail(`this CLI uses the server at ${configured}; run yok server use --unset first`);
  return true;
};

export const serverCommand = () => {
  const server = new Command("server").description("Manage the yok server process");

  server
    .command("start")
    .description("Run the yok server in the foreground")
    .option(
      "--port <port>",
      "port to listen on at 127.0.0.1 (default: the last one used)",
      parsePort,
    )
    .action(async ({ port }) => {
      const home = yokHome();
      if (refuseWhenConfigured(home)) return;
      const running = await runningServer(home);
      if (running !== null) {
        commandLog("server start").info({ pid: running.pid }, "server already running");
        console.log(`already running (pid ${running.pid})`);
        return;
      }
      // Bun.serve keeps the process alive; startServer's own SIGINT/SIGTERM handler exits it.
      await startServer({ home, ...(port === undefined ? {} : { port }) });
    });

  server
    .command("stop")
    .description("Stop the running yok server")
    .action(async () => {
      const home = yokHome();
      if (refuseWhenConfigured(home)) return;
      const running = await runningServer(home);
      if (running === null) return fail("not running");
      await stopServer(running.pid).catch(fail);
    });

  server
    .command("status")
    .description("Show whether the yok server is running")
    .action(async () => {
      const configured = configuredServerUrl();
      if (configured === null) {
        const running = await runningServer();
        if (running === null) {
          console.log("not running");
          process.exitCode = 1;
          return;
        }
        return console.log(`pid ${running.pid}, version ${running.version}`);
      }
      // A configured server's pid cannot be checked from here, so its reply is taken as it is.
      const health = await yokClient().health();
      if (!health.ok) {
        console.log(`${configured}: not answering`);
        process.exitCode = 1;
        return;
      }
      console.log(`${configured}: pid ${health.value.pid}, version ${health.value.version}`);
    });

  server
    .command("use")
    .description("Point this CLI at a server by URL and key")
    .argument("[url]", "the server's URL")
    .option("--key <key>", "the server's API key (default: $YOK_API_KEY)")
    .option("--unset", "forget the URL and key; the CLI then uses the server yok runs here")
    .action(async (url, opts) => {
      const home = yokHome();
      if (opts.unset) {
        // The key goes with its URL; the next start here mints its own.
        await updateHomeEnv(home, { YOK_SERVER_URL: null, YOK_API_KEY: null });
        console.log("using the server yok runs on this machine");
        if (process.env.YOK_SERVER_URL) console.log("YOK_SERVER_URL is still set and wins");
        return;
      }
      if (url === undefined) return fail("pass the server's URL, or --unset");
      const apiKey = opts.key ?? process.env.YOK_API_KEY;
      if (!apiKey) return fail("pass --key KEY or set YOK_API_KEY");
      await useRemote(home, url, apiKey);
    });

  return server;
};
