import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, loginPassword, remoteSettings } from "./remote.ts";

const dirs: string[] = [];
const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "yok-remote-home-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PASSWORD = `p#ss'w"rd`;
const basicFor = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("remoteSettings", () => {
  test("SC4001: all three login variables come from the shell when it sets the URL, else all from HOME/.env", () => {
    const home = tempHome();
    writeFileSync(
      join(home, ".env"),
      "YOK_SERVER_URL=https://yok.example.com/\nYOK_SERVER_USER=ritesh\nYOK_SERVER_PASSWORD=old\n",
    );

    expect(remoteSettings({}, home)).toEqual({
      url: "https://yok.example.com",
      user: "ritesh",
      password: "old",
    });
    expect(
      remoteSettings(
        {
          YOK_SERVER_URL: "https://ci.example.com",
          YOK_SERVER_USER: "ci",
          YOK_SERVER_PASSWORD: "new",
        },
        home,
      ),
    ).toEqual({ url: "https://ci.example.com", user: "ci", password: "new" });
  });

  test("SC4012: a shell password alone is not sent to the saved server, and a shell URL does not borrow the saved login", () => {
    const home = tempHome();
    writeFileSync(
      join(home, ".env"),
      "YOK_SERVER_URL=https://yok.example.com\nYOK_SERVER_USER=ritesh\nYOK_SERVER_PASSWORD=old\n",
    );

    expect(remoteSettings({ YOK_SERVER_PASSWORD: "new" }, home).password).toBe("old");
    expect(() => remoteSettings({ YOK_SERVER_URL: "https://ci.example.com" }, home)).toThrow(
      /YOK_SERVER_USER, YOK_SERVER_PASSWORD not set/,
    );
  });

  test("SC4002: a missing login variable stops with its name and the login command", () => {
    const home = tempHome();
    writeFileSync(join(home, ".env"), "YOK_SERVER_URL=https://yok.example.com\n");

    expect(() => remoteSettings({}, home)).toThrow(
      /YOK_SERVER_USER, YOK_SERVER_PASSWORD not set; run yok remote login/,
    );
  });

  test("SC4003: a plain-http URL to another machine is refused by remoteSettings and by login, before any request", async () => {
    const url = "http://yok.example.com";
    const refused = "must use https:// unless the server is on this machine";
    const home = tempHome();

    expect(() =>
      remoteSettings({ YOK_SERVER_URL: url, YOK_SERVER_USER: "u", YOK_SERVER_PASSWORD: "p" }, home),
    ).toThrow(refused);
    await expect(login({ url, user: "u", password: "p" }, home)).rejects.toThrow(refused);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });
});

// A stand-in for Caddy's basic_auth: 401 unless the request carries ritesh's login.
const basicAuthServer = (password: string) => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.headers.get("authorization") !== basicFor("ritesh", password)) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({ projects: [] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
};

describe("login", () => {
  test("SC4004: login saves the three variables only after the server accepts them, keeping the other lines", async () => {
    const home = tempHome();
    writeFileSync(join(home, ".env"), "SERVER_DOMAIN=yok.example.com\n");
    const server = basicAuthServer(PASSWORD);

    const done = await login({ url: server.url, user: "ritesh", password: PASSWORD }, home);
    server.stop();

    expect(done).toBe(`logged in to ${server.url} as ritesh`);
    expect(server.seen).toEqual(["GET /api/projects"]);
    expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
    const saved = readFileSync(join(home, ".env"), "utf8");
    expect(saved).toContain("SERVER_DOMAIN=yok.example.com\n");
    expect(saved).toContain("YOK_SERVER_USER=");
    expect(remoteSettings({}, home)).toEqual({
      url: server.url,
      user: "ritesh",
      password: PASSWORD,
    });
  });

  test("SC4005: a wrong password saves nothing", async () => {
    const home = tempHome();
    const working = `YOK_SERVER_URL=https://yok.example.com\nYOK_SERVER_USER=ritesh\nYOK_SERVER_PASSWORD=${"'right'"}\n`;
    writeFileSync(join(home, ".env"), working);
    const server = basicAuthServer("right");

    const attempt = login({ url: server.url, user: "ritesh", password: "wrong" }, home);

    await expect(attempt).rejects.toThrow("wrong username or password");
    server.stop();
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(working);
  });
});

describe("loginPassword", () => {
  const never = async (): Promise<string> => {
    throw new Error("asked");
  };

  test("SC4010: the flag wins, then YOK_SERVER_PASSWORD, and only then is the password asked for", async () => {
    expect(await loginPassword("flag", { YOK_SERVER_PASSWORD: "env" }, never)).toBe("flag");
    expect(await loginPassword(undefined, { YOK_SERVER_PASSWORD: "env" }, never)).toBe("env");
    expect(await loginPassword(undefined, {}, async () => "typed")).toBe("typed");
  });

  test("SC4011: a password read from stdin loses its line ending only", async () => {
    expect(await loginPassword(undefined, {}, async () => " p w \r\n")).toBe(" p w ");
  });
});
