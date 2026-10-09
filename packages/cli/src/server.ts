import { Command } from "@commander-js/extra-typings";
import { yokHome } from "@yok/sdk";
import { startServer } from "@yok/server";
import { commandLog, fail, stopServer, yokClient } from "./client.ts";

export const serverCommand = () => {
  const server = new Command("server").description("Manage the yok server process");

  server
    .command("start")
    .description("Run the yok server in the foreground")
    .action(async () => {
      const home = yokHome();
      const running = await yokClient(home).health();
      if (running.ok) {
        commandLog("server start").info({ pid: running.value.pid }, "server already running");
        console.log(`already running (pid ${running.value.pid})`);
        return;
      }
      // Bun.serve keeps the process alive; startServer's own SIGINT/SIGTERM handler exits it.
      await startServer({ home });
    });

  server
    .command("stop")
    .description("Stop the running yok server")
    .action(async () => {
      const home = yokHome();
      const running = await yokClient(home).health();
      if (!running.ok) {
        return fail("not running");
      }
      await stopServer(home, running.value.pid).catch(fail);
    });

  server
    .command("status")
    .description("Show whether the yok server is running")
    .action(async () => {
      const result = await yokClient().health();
      if (!result.ok) {
        console.log("not running");
        process.exitCode = 1;
        return;
      }
      console.log(`pid ${result.value.pid}, version ${result.value.version}`);
    });

  return server;
};
