import { findRunPane, type ILogger, type ITerminalHost, type Result } from "@yok/sdk";
import type { Registry } from "@yok/sdk/internal";
import type { Subprocess } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import * as z from "zod";

export type TerminalDeps = Readonly<{ registry: Registry; host: ITerminalHost; log: ILogger }>;

// Close codes the page tells apart: the person detached (it offers Reattach), or the run has no
// session to attach to (it shows why). Any other close is a dropped socket, which it retries.
export const DETACHED = 4000;
export const REFUSED = 4001;

const SizeSchema = z.object({
  cols: z.coerce.number().int().min(2).max(1000).catch(80),
  rows: z.coerce.number().int().min(2).max(500).catch(24),
});
type Size = z.infer<typeof SizeSchema>;

// Every browser message is a JSON text frame; a ping only keeps proxies from closing an idle socket.
const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({
    type: z.literal("resize"),
    cols: z.int().min(2).max(1000),
    rows: z.int().min(2).max(500),
  }),
  z.object({ type: z.literal("ping") }),
]);
type ClientMessage = z.infer<typeof ClientMessageSchema>;

const parseMessage = (raw: unknown): ClientMessage | null => {
  if (typeof raw !== "string") return null;
  try {
    const parsed = ClientMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const attachArgv = async (deps: TerminalDeps, id: string): Promise<Result<readonly string[]>> => {
  const run = await deps.registry.findRun(id);
  if (run === undefined) return { ok: false, error: `run ${id} not found` };
  const pane = await findRunPane(deps.host, run);
  return pane.ok ? { ok: true, value: pane.value.attachCommand() } : pane;
};

// A tmux client started inside a pane would nest; TERM is what xterm.js speaks.
const attachEnv = (env: NodeJS.ProcessEnv): Record<string, string | undefined> => {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = env;
  return { ...rest, TERM: "xterm-256color" };
};

const spawnAttach = (argv: readonly string[], size: Size, ws: WSContext): Subprocess =>
  Bun.spawn([...argv], {
    env: attachEnv(process.env),
    terminal: { cols: size.cols, rows: size.rows, data: (_terminal, bytes) => ws.send(bytes) },
  });

// Mounted at /runs by app.ts, so the root's hostGuard checks Host and Origin before the upgrade.
// Closing the socket ends only the attach process: the run's session belongs to the run.
export const terminalRoutes = (deps: TerminalDeps) =>
  new Hono().get("/:id/terminal", async (c) => {
    const id = c.req.param("id");
    const argv = await attachArgv(deps, id);
    const size = SizeSchema.parse(c.req.query());
    const log = deps.log.child({ component: "terminal", runId: id });
    let attach: Subprocess | null = null;
    return upgradeWebSocket(c, {
      onOpen: (_event, ws) => {
        if (!argv.ok) {
          ws.send(JSON.stringify({ type: "refused", message: argv.error }));
          ws.close(REFUSED, "refused");
          return;
        }
        const started = spawnAttach(argv.value, size, ws);
        attach = started;
        log.info(size, "browser terminal attached");
        void started.exited.then((code) => {
          log.info({ code }, "browser terminal detached");
          ws.close(DETACHED, "detached");
        });
      },
      onMessage: (event) => {
        const message = parseMessage(event.data);
        const terminal = attach?.terminal;
        if (message === null || terminal === undefined) return;
        if (message.type === "input") terminal.write(message.data);
        if (message.type === "resize") terminal.resize(message.cols, message.rows);
      },
      onClose: () => attach?.kill(),
    });
  });
