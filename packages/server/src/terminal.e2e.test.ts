import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize, yokTerminalHost } from "@yok/core";
import { registryPath, type WorkflowRun } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";
import { claudeOver } from "./fake-host.ts";
import { readPort } from "./protocol.ts";
import { startServer } from "./server.ts";
import { DETACHED, REFUSED } from "./terminal.ts";

const SESSION = "demo-pane";

type Setup = Readonly<{ port: number; socket: string }>;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const savedRun = (id: string, cwd: string, terminal: string | null): WorkflowRun => ({
  id,
  workflow: "demo",
  workflowPath: join(cwd, "demo.yaml"),
  inputs: {},
  cwd,
  sessions: [],
  name: null,
  terminal,
  config: null,
  tiers: null,
  createdAt: new Date().toISOString(),
});

// A real server whose host is a tmux server on its own socket, holding one session that runs sh.
const setUp = async (): Promise<Setup> => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "yok-term-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-term-cwd-")));
  const socket = `yok-test-${randomUUID()}`;
  const host = yokTerminalHost({ YOK_HOME: home, YOK_TMUX_SOCKET: socket });
  const pane = await host.create({
    name: SESSION,
    cwd,
    argv: ["sh", "-c", "echo pane-ready; exec sh"],
    env: { PS1: "$ " },
  });
  if (!pane.ok) throw new Error(pane.error);
  const registry = createRegistry(registryPath(home));
  await registry.addRun(savedRun("r-1", cwd, SESSION));
  await registry.addRun(savedRun("r-2", cwd, null));
  const server = await startServer({
    home,
    runtime: {
      host,
      providerFor: () => claudeOver(host),
      checkCheckout: async () => ({ env: { ok: true, value: {} }, report: summarize([]) }),
    },
  });
  cleanups.push(async () => {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    await server.stop();
  });
  return { port: readPort(home) as number, socket };
};

const tmux = (socket: string, ...args: string[]): string =>
  execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" }).trim();

const windowSize = (socket: string): string =>
  tmux(socket, "display", "-p", "-t", `=${SESSION}:`, "#{window_width}x#{window_height}");

const clients = (socket: string): string =>
  tmux(socket, "list-clients", "-t", `=${SESSION}:`, "-F", "#{client_name}");

const hasSession = (socket: string): boolean =>
  spawnSync("tmux", ["-L", socket, "has-session", "-t", `=${SESSION}`]).status === 0;

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
};

type Client = Readonly<{
  ws: WebSocket;
  screen: () => string;
  texts: readonly string[];
  closed: Promise<CloseEvent>;
}>;

// Bun's WebSocket takes headers, so it can send the Origin a browser on the page would.
const connect = (port: number, id: string, query = ""): Client => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runs/${id}/terminal${query}`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const decoder = new TextDecoder();
  let screen = "";
  const texts: string[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") texts.push(event.data);
    else screen += decoder.decode(event.data as ArrayBuffer, { stream: true });
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
  return { ws, screen: () => screen, texts, closed };
};

const send = (client: Client, message: unknown): void => client.ws.send(JSON.stringify(message));

const attached = async (setup: Setup, query = "?cols=90&rows=20"): Promise<Client> => {
  const client = connect(setup.port, "r-1", query);
  await until(() => client.screen().includes("pane-ready"));
  await until(() => clients(setup.socket) !== "");
  return client;
};

const paneText = (socket: string): string =>
  tmux(socket, "capture-pane", "-p", "-t", `=${SESSION}:`);

describe("the run's terminal websocket", () => {
  test("SC5: pane output reaches the socket, at the size the client asked for", async () => {
    const setup = await setUp();

    const client = await attached(setup);

    expect(client.screen()).toContain("pane-ready");
    await until(() => windowSize(setup.socket) === "90x20");
  }, 20_000);

  test("SC6: typed input reaches the session", async () => {
    const setup = await setUp();
    const client = await attached(setup);

    send(client, { type: "input", data: "echo typed-$((40+2))\r" });

    await until(() => paneText(setup.socket).split("\n").includes("typed-42"));
  }, 20_000);

  test("SC7: a resize message resizes the pane", async () => {
    const setup = await setUp();
    const client = await attached(setup);
    await until(() => windowSize(setup.socket) === "90x20");

    send(client, { type: "resize", cols: 120, rows: 30 });

    await until(() => windowSize(setup.socket) === "120x30");
  }, 20_000);

  test("SC8: bad messages are ignored and the socket stays usable", async () => {
    const setup = await setUp();
    const client = await attached(setup);
    await until(() => windowSize(setup.socket) === "90x20");

    client.ws.send("not json");
    send(client, { type: "shout" });
    send(client, { type: "resize", cols: 0, rows: 5 });
    client.ws.send(new Uint8Array([1, 2, 3]));
    send(client, { type: "input", data: "echo still-$((1+1))\r" });

    await until(() => paneText(setup.socket).split("\n").includes("still-2"));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(windowSize(setup.socket)).toBe("90x20");
  }, 20_000);

  test("SC9: closing the socket leaves the session alive", async () => {
    const setup = await setUp();
    const client = await attached(setup);

    client.ws.close();

    await until(() => clients(setup.socket) === "");
    expect(hasSession(setup.socket)).toBe(true);
  }, 20_000);

  test("SC10: Ctrl-\\ detaches, and the socket closes as detached", async () => {
    const setup = await setUp();
    const client = await attached(setup);

    send(client, { type: "input", data: "\u001c" });

    expect((await client.closed).code).toBe(DETACHED);
    expect(hasSession(setup.socket)).toBe(true);
  }, 20_000);

  test.each([
    ["r-2", "run r-2 has no terminal yet"],
    ["nope", "run nope not found"],
  ])(
    "SC11: run %s gets a refusal frame saying %s, then close 4001",
    async (id, message) => {
      const setup = await setUp();

      const client = connect(setup.port, id);
      const closed = await client.closed;

      expect(client.texts.map((text) => JSON.parse(text))).toEqual([{ type: "refused", message }]);
      expect(closed.code).toBe(REFUSED);
    },
    20_000,
  );

  test("SC12: the guard refuses a foreign Origin before the upgrade, and nothing attaches", async () => {
    const setup = await setUp();

    const reply = await fetch(`http://127.0.0.1:${setup.port}/api/runs/r-1/terminal`, {
      headers: {
        Origin: "https://evil.example",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });

    expect(reply.status).toBe(403);
    await Bun.sleep(300);
    expect(clients(setup.socket)).toBe("");
  }, 20_000);
});
