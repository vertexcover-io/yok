import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStorage } from "@yok/sdk/internal";
import { readPort, signValue } from "@yok/server";

const CLI = join(import.meta.dir, "index.ts");
const SECRET = "e2e-session-secret";
const DOMAIN = "yok.example.com";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const yokAsync = (env: NodeJS.ProcessEnv, args: readonly string[]): ChildProcess =>
  spawn("bun", ["--env-file=/dev/null", CLI, ...args], { env });

const yok = (env: NodeJS.ProcessEnv, ...args: string[]) => {
  const run = spawnSync("bun", ["--env-file=/dev/null", CLI, ...args], { env, encoding: "utf8" });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

const outputOf = (child: ChildProcess): { text: () => string } => {
  let text = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    text += chunk;
  });
  return { text: () => text };
};

const until = async (predicate: () => boolean): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 20_000) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
};

// A real yok server that started gated (SERVER_DOMAIN set) with Ada as its one user.
const gatedServer = async () => {
  const home = mkdtempSync(join(tmpdir(), "yok-login-e2e-"));
  writeFileSync(
    join(home, ".env"),
    `SERVER_DOMAIN=${DOMAIN}\nSUPER_ADMIN_LOGINS=ada\nYOK_SESSION_SECRET=${SECRET}\n`,
  );
  const userId = await withStorage(home, async (storage) => {
    const [id] = await storage.users.saveGitHubUser({
      id: 1,
      login: "ada",
      name: "Ada",
      email: "",
      token: "gho_x",
    });
    return id;
  });
  const env = { ...process.env, YOK_HOME: home, YOK_SERVER_URL: undefined };
  cleanups.push(() => {
    yok(env, "server", "stop");
    rmSync(home, { recursive: true, force: true });
  });
  return { home, env, userId };
};

describe("yok login and logout against a gated server", () => {
  test("SC24, SC25, SC28: a plain command is refused with the way in, login saves a working token, and logout revokes it", async () => {
    const { home, env, userId } = await gatedServer();

    const plain = yok(env, "project", "list");
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain(`run yok login --server https://${DOMAIN}`);
    expect(plain.stderr).toContain("--remote");

    const origin = `http://127.0.0.1:${readPort(home)}`;
    const login = yokAsync(env, ["login", "--server", origin, "--no-open"]);
    const shown = outputOf(login);
    const closed = new Promise<number>((done) => login.on("close", (code) => done(code ?? 1)));
    await until(() => /approve the code [A-Z]{4}-[A-Z]{4}/.test(shown.text()));
    const userCode = /approve the code ([A-Z]{4}-[A-Z]{4})/.exec(shown.text())?.[1] ?? "";
    expect(shown.text()).toContain(`/device?code=${userCode}`);
    const session = signValue(SECRET, {
      sub: userId,
      purpose: "session",
      exp: Date.now() + 60_000,
    });
    const approved = await fetch(`${origin}/device`, {
      method: "POST",
      headers: {
        cookie: `yok_session=${session}`,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: userCode }),
    });

    expect(approved.status).toBe(200);
    expect(await closed).toBe(0);
    expect(shown.text()).toContain(`logged in to ${origin} as ada`);
    const saved = readFileSync(join(home, ".env"), "utf8");
    expect(saved).toMatch(/^YOK_SERVER_TOKEN=yok_[A-Za-z0-9_-]{43}$/m);
    expect(saved).toContain(`YOK_SERVER_URL=${origin}`);
    expect(saved).toContain(`SERVER_DOMAIN=${DOMAIN}`);
    expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(await withStorage(home, (storage) => storage.users.listTokens(userId))).toHaveLength(1);

    expect(yok(env, "--remote", "project", "list").code).toBe(0);

    const out = yok(env, "logout");
    expect(out.stdout).toContain(`logged out of ${origin}`);
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain("YOK_SERVER_TOKEN");
    expect(await withStorage(home, (storage) => storage.users.listTokens(userId))).toEqual([]);
    expect(yok(env, "--remote", "project", "list").stderr).toContain(
      `YOK_SERVER_TOKEN not set; run yok login --server ${origin}`,
    );
  }, 60_000);
});
