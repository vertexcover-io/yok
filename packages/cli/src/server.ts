import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import { yokHome } from "@yok/sdk";
import { VERSION } from "@yok/sdk/internal";
import { startServer } from "@yok/server";
import { commandLog, connect, fail, isRemote, runningServer, stopServer } from "./client.ts";

const parsePort = (text: string): number => {
  const port = Number(text);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  throw new InvalidArgumentError(`--port must be a port number, got "${text}"`);
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
      const running = await runningServer(home);
      if (running === null) return fail("not running");
      await stopServer(running.pid).catch(fail);
    });

  server
    .command("status")
    .description("Show whether the yok server is running; with --remote, the saved server's")
    .action(async (_opts, command) => {
      if (isRemote(command)) {
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
        return;
      }
      const running = await runningServer();
      if (running === null) {
        console.log("not running");
        process.exitCode = 1;
        return;
      }
      console.log(`pid ${running.pid}, version ${running.version}`);
    });

  return server;
};
