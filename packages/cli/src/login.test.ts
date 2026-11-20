import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteSettings } from "./client.ts";
import { login, logout } from "./login.ts";

const dirs: string[] = [];
const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "yok-remote-home-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "yok_Zm9vYmFyLWJhei1xdXV4LXRva2VuLWJ5dGVzLTEyMzQ1Ng";

describe("remoteSettings", () => {
  test("SC4001: both login variables come from the shell when it sets the URL, else both from HOME/.env", () => {
    const home = tempHome();
    writeFileSync(
      join(home, ".env"),
      `YOK_SERVER_URL=https://yok.example.com/\nYOK_SERVER_TOKEN=${TOKEN}\n`,
    );

    expect(remoteSettings({}, home)).toEqual({ url: "https://yok.example.com", token: TOKEN });
    expect(
      remoteSettings(
        { YOK_SERVER_URL: "https://ci.example.com", YOK_SERVER_TOKEN: "yok_ci" },
        home,
      ),
    ).toEqual({ url: "https://ci.example.com", token: "yok_ci" });
  });

  test("SC4012: a shell token alone is not sent to the saved server, and a shell URL does not borrow the saved token", () => {
    const home = tempHome();
    writeFileSync(
      join(home, ".env"),
      `YOK_SERVER_URL=https://yok.example.com\nYOK_SERVER_TOKEN=${TOKEN}\n`,
    );

    expect(remoteSettings({ YOK_SERVER_TOKEN: "yok_other" }, home).token).toBe(TOKEN);
    expect(() => remoteSettings({ YOK_SERVER_URL: "https://ci.example.com" }, home)).toThrow(
      "YOK_SERVER_TOKEN not set; run yok login --server https://ci.example.com",
    );
  });

  test("SC4002: a missing URL or token stops with its name and the login command", () => {
    const home = tempHome();

    expect(() => remoteSettings({}, home)).toThrow(
      "YOK_SERVER_URL not set; run yok login --server URL",
    );
    writeFileSync(join(home, ".env"), "YOK_SERVER_URL=https://yok.example.com\n");
    expect(() => remoteSettings({}, home)).toThrow(
      "YOK_SERVER_TOKEN not set; run yok login --server https://yok.example.com",
    );
  });

  test("SC27: a saved password and no token says passwords no longer work and to run yok login --server URL", () => {
    const home = tempHome();
    writeFileSync(
      join(home, ".env"),
      "YOK_SERVER_URL=https://yok.example.com\nYOK_SERVER_USER=ritesh\nYOK_SERVER_PASSWORD=old\n",
    );

    expect(() => remoteSettings({}, home)).toThrow(
      /password.*run yok login --server https:\/\/yok\.example\.com/,
    );
  });

  test("SC4003: a plain-http URL to another machine is refused by remoteSettings and by login, before any request", async () => {
    const url = "http://yok.example.com";
    const refused = "must use https:// unless the server is on this machine";
    const home = tempHome();

    expect(() => remoteSettings({ YOK_SERVER_URL: url, YOK_SERVER_TOKEN: "yok_x" }, home)).toThrow(
      refused,
    );
    await expect(
      login({ url, home, hostname: "laptop", onVerification: () => {} }),
    ).rejects.toThrow(refused);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });
});

type Seen = Readonly<{ request: string; authorization: string | null; body: string }>;

// A yok server's device-login and token routes: the token goes out on the first poll after
// approve() once pollsBeforeApproval polls have passed, and only a request that carries it is
// signed in (none is when acceptsToken is false).
const deviceServer = ({
  expiresIn = 600,
  interval = 0,
  pollsBeforeApproval = 0,
  acceptsToken = true,
} = {}) => {
  const seen: Seen[] = [];
  let polls = 0;
  let approved = false;
  let revoked = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      const body = await request.text();
      const authorization = request.headers.get("authorization");
      seen.push({ request: `${request.method} ${pathname}`, authorization, body });
      if (pathname === "/api/auth/device") {
        return Response.json({
          deviceCode: "device-code-1",
          userCode: "ABCD-EFGH",
          verificationUrl: `${new URL(request.url).origin}/device`,
          expiresIn,
          interval,
        });
      }
      if (pathname === "/api/auth/device/token") {
        polls += 1;
        return approved && polls > pollsBeforeApproval
          ? Response.json({ status: "approved", token: TOKEN })
          : Response.json({ status: "pending" });
      }
      if (authorization !== `Bearer ${TOKEN}` || revoked || !acceptsToken) {
        const error = { code: "unauthenticated", message: "sign in" };
        return Response.json({ error }, { status: 401 });
      }
      if (pathname === "/api/me") {
        return Response.json({ user: { id: "u1", name: "Ritesh", email: "", login: "ritesh-gh" } });
      }
      revoked = true;
      return Response.json({ revoked: true });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    approve: () => {
      approved = true;
    },
    stop: () => server.stop(true),
  };
};

describe("login", () => {
  test("SC24: login prints the code, polls until approved, checks /api/me and saves the URL and token at mode 0600 without the password keys", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, ".env"),
      "SERVER_DOMAIN=yok.example.com\nYOK_SERVER_USER=ritesh\nYOK_SERVER_PASSWORD=old\n",
    );
    const server = deviceServer({ pollsBeforeApproval: 2 });
    const shown: Array<{ url: string; userCode: string }> = [];

    const done = await login({
      url: `${server.url}/`,
      home,
      hostname: "ritesh-mbp",
      onVerification: (verification) => {
        shown.push(verification);
        server.approve();
      },
    });
    server.stop();

    expect(shown).toEqual([{ url: `${server.url}/device`, userCode: "ABCD-EFGH" }]);
    expect(done).toBe(`logged in to ${server.url} as ritesh-gh`);
    expect(server.seen.map((call) => call.request)).toEqual([
      "POST /api/auth/device",
      "POST /api/auth/device/token",
      "POST /api/auth/device/token",
      "POST /api/auth/device/token",
      "GET /api/me",
    ]);
    expect(JSON.parse(server.seen[0]?.body ?? "")).toEqual({ hostname: "ritesh-mbp" });
    expect(server.seen.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(
      `SERVER_DOMAIN=yok.example.com\nYOK_SERVER_URL=${server.url}\nYOK_SERVER_TOKEN=${TOKEN}\n`,
    );
  });

  test("a login nobody approves in time stops at the server's expiry with a message, saving nothing", async () => {
    const home = tempHome();
    const server = deviceServer({ expiresIn: 1, interval: 1 });

    const attempt = login({ url: server.url, home, hostname: "laptop", onVerification: () => {} });

    await expect(attempt).rejects.toThrow("not approved in time; run yok login again");
    server.stop();
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  test.each([
    {
      reply: Response.json(
        {
          error: {
            code: "too-many-requests",
            message: "too many login requests are waiting; try again in a few minutes",
          },
        },
        { status: 429 },
      ),
      shown: "too many login requests are waiting; try again in a few minutes",
    },
    {
      reply: new Response("<html>Bad gateway</html>", { status: 502 }),
      shown: "answered /api/auth/device with 502; is it a yok server?",
    },
  ])(
    "a refused login start shows the yok server's own message, else asks whether it is a yok server: $shown",
    async ({ reply, shown }) => {
      const home = tempHome();
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => reply.clone() });

      const attempt = login({
        url: `http://127.0.0.1:${server.port}`,
        home,
        hostname: "laptop",
        onVerification: () => {},
      });

      await expect(attempt).rejects.toThrow(shown);
      server.stop(true);
      expect(existsSync(join(home, ".env"))).toBe(false);
    },
  );

  test("a token the server does not accept on /api/me is not saved", async () => {
    const home = tempHome();
    const working = "YOK_SERVER_URL=https://yok.example.com\nYOK_SERVER_TOKEN=yok_old\n";
    writeFileSync(join(home, ".env"), working);
    const server = deviceServer({ acceptsToken: false });
    server.approve();

    const attempt = login({ url: server.url, home, hostname: "laptop", onVerification: () => {} });

    await expect(attempt).rejects.toThrow("did not accept the new token");
    server.stop();
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(working);
  });
});

describe("logout", () => {
  test("SC25: logout revokes the token on the server and removes only YOK_SERVER_TOKEN from .env", async () => {
    const home = tempHome();
    const server = deviceServer();
    writeFileSync(
      join(home, ".env"),
      `SERVER_DOMAIN=yok.example.com\nYOK_SERVER_URL=${server.url}\nYOK_SERVER_TOKEN=${TOKEN}\n`,
    );

    const done = await logout(home);
    const again = await fetch(`${server.url}/api/me`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    server.stop();

    expect(done).toBe(`logged out of ${server.url}`);
    expect(server.seen.map((call) => [call.request, call.authorization]).slice(0, 1)).toEqual([
      ["DELETE /api/tokens/current", `Bearer ${TOKEN}`],
    ]);
    expect(again.status).toBe(401);
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(
      `SERVER_DOMAIN=yok.example.com\nYOK_SERVER_URL=${server.url}\n`,
    );
  });

  test("a token the server already revoked is still removed from .env, and an unreachable server keeps it", async () => {
    const home = tempHome();
    const server = deviceServer();
    writeFileSync(
      join(home, ".env"),
      `YOK_SERVER_URL=${server.url}\nYOK_SERVER_TOKEN=yok_revoked_elsewhere\n`,
    );

    await logout(home);
    server.stop();

    expect(readFileSync(join(home, ".env"), "utf8")).toBe(`YOK_SERVER_URL=${server.url}\n`);
    const down = `YOK_SERVER_URL=http://127.0.0.1:1\nYOK_SERVER_TOKEN=${TOKEN}\n`;
    writeFileSync(join(home, ".env"), down);
    await expect(logout(home)).rejects.toThrow("127.0.0.1:1: server unreachable");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(down);
  });
});
