import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linkSlack,
  ownerEnv,
  readUsers,
  setAccountToken,
  updateUsers,
  usersPath,
} from "./users.ts";

describe("users file", () => {
  test("SC3: updateUsers creates users.json readable by its owner only, and readUsers returns the user", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "users-")), "yok-home");
    const user = {
      name: "Ritesh",
      email: "ritesh@example.com",
      accounts: { github: { id: 1, login: "ritesh-gh", token: "gho_a" } },
    };

    await updateUsers(home, (users) => ({ ...users, u_1a2b3c4d: user }));

    expect((await stat(usersPath(home))).mode & 0o777).toBe(0o600);
    expect(await readUsers(home)).toEqual({ u_1a2b3c4d: user });
  });
});

describe("Slack link", () => {
  test("SC9: linking Slack member U7 to user B moves it off user A, who had it", () => {
    const person = { name: "P", email: "", accounts: {} };
    const users = { u_a: { ...person, slack: "U7" }, u_b: person };

    const linked = linkSlack(users, "u_b", "U7");

    expect(linked.u_b?.slack).toBe("U7");
    expect(linked.u_a).toEqual(person);
  });
});

describe("account tokens", () => {
  test("SC18: dropping the GitHub token keeps the account it belongs to, and a missing user id returns the same object", () => {
    const github = { id: 1, login: "ritesh-gh" };
    const users = {
      u_a: { name: "R", email: "", accounts: { github: { ...github, token: "gho_a" } } },
    };

    const dropped = setAccountToken(users, "u_a", "github", undefined);

    expect(dropped.u_a?.accounts.github).toEqual(github);
    expect(setAccountToken(users, "u_missing", "github", undefined)).toBe(users);
  });

  test("a token goes back onto the account it was dropped from, and never onto an account the user lacks", () => {
    const users = { u_a: { name: "R", email: "", accounts: { github: { id: 1, login: "r" } } } };
    const none = { u_b: { name: "B", email: "", accounts: {} } };

    expect(setAccountToken(users, "u_a", "github", "gho_b").u_a?.accounts.github).toEqual({
      id: 1,
      login: "r",
      token: "gho_b",
    });
    expect(setAccountToken(none, "u_b", "github", "gho_b")).toBe(none);
  });
});

describe("ownerEnv", () => {
  const github = { id: 8675309, login: "ritesh-gh" };
  const person = { name: "R", email: "", accounts: { github } };

  test("SC23: a connected owner's env carries their token, not the project's, and their noreply identity", () => {
    const owner = { ...person, accounts: { github: { ...github, token: "gho_x" } } };

    const env = ownerEnv({ GH_TOKEN: "project", GITHUB_TOKEN: "server", FOO: "1" }, "/h", owner);

    const noreply = "8675309+ritesh-gh@users.noreply.github.com";
    expect(env).toMatchObject({
      GH_TOKEN: "gho_x",
      GITHUB_TOKEN: "gho_x",
      GIT_AUTHOR_EMAIL: noreply,
      GIT_COMMITTER_EMAIL: noreply,
      GH_CONFIG_DIR: "/h/gh-owned",
      FOO: "1",
    });
  });

  test.each([
    ["SC24: an owner whose GitHub account holds no token gets no GitHub token", person],
    ["SC24: no owner record gets no GitHub token", undefined],
  ])("%s, but still the isolated gh and git config", (_label, owner) => {
    const env = ownerEnv({ GH_TOKEN: "project", GITHUB_TOKEN: "p2" }, "/h", owner);

    // Set empty, not left out: the session's env is laid over the server's own, which may hold one.
    expect(env.GH_TOKEN).toBe("");
    expect(env.GITHUB_TOKEN).toBe("");
    expect(Object.keys(env).filter((key) => key.startsWith("GIT_AUTHOR_"))).toEqual([]);
    expect(env.GH_CONFIG_DIR).toBe("/h/gh-owned");
    expect(env.GIT_CONFIG_COUNT).toBe("5");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
  });
});

describe("git under ownerEnv", () => {
  // A machine-wide helper that would hand out the server's password, and a gh that, like gh 2.45
  // with its login in the system keyring, answers with the server's token when GH_TOKEN is empty.
  const machine = async (): Promise<Record<string, string>> => {
    const home = await mkdtemp(join(tmpdir(), "owner-git-"));
    await writeFile(
      join(home, ".gitconfig"),
      '[credential]\n\thelper = "!f() { echo username=server; echo password=leaked; }; f"\n',
    );
    const bin = join(home, "bin");
    await mkdir(bin);
    const gh = join(bin, "gh");
    await writeFile(
      gh,
      '#!/bin/sh\ntoken=$GH_TOKEN\n[ -n "$token" ] || token=keyring\nprintf "username=x-access-token\\npassword=%s\\n" "$token"\n',
    );
    await chmod(gh, 0o755);
    return { HOME: home, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1" };
  };

  const git = (env: Record<string, string>, args: readonly string[], input = "") =>
    spawnSync("git", args, { env, input, encoding: "utf8" });

  const fill = (env: Record<string, string>) =>
    git(env, ["credential", "fill"], "protocol=https\nhost=github.com\n\n");

  const person = { name: "R", email: "", accounts: {} };

  test("SC25: with a token git fills the owner's token, and SSH remotes become HTTPS", async () => {
    const base = await machine();
    const owner = {
      ...person,
      accounts: { github: { id: 1, login: "r", token: "gho_owner" } },
    };
    const env = ownerEnv(base, base.HOME ?? "", owner);

    const filled = fill(env);
    const url = git(env, ["ls-remote", "--get-url", "git@github.com:a/b.git"]);

    expect(filled.stdout).toContain("password=gho_owner");
    expect(filled.stdout + filled.stderr).not.toContain("leaked");
    expect(url.stdout.trim()).toBe("https://github.com/a/b.git");
  });

  test("SC25: without a token git gets no credential, neither the machine's helper nor gh's keyring login", async () => {
    const base = await machine();
    const env = ownerEnv(base, base.HOME ?? "", person);

    const filled = fill(env);

    expect(filled.status).not.toBe(0);
    expect(filled.stdout).not.toContain("password=");
    expect(filled.stdout + filled.stderr).not.toContain("leaked");
  });

  // An askpass program, such as VS Code's bridge, answers with the login the editor holds. The
  // server may name it in its env, or the machine's git config may set core.askPass.
  const askpassMachine = async (): Promise<{
    base: Record<string, string>;
    home: string;
    script: string;
  }> => {
    const base = await machine();
    const home = base.HOME ?? "";
    const script = join(home, "askpass");
    await writeFile(script, "#!/bin/sh\necho askpass-leaked\n");
    await chmod(script, 0o755);
    await writeFile(join(home, "askpass.gitconfig"), `[core]\n\taskPass = ${script}\n`);
    return { base, home, script };
  };

  test.each([
    ["GIT_ASKPASS", (script: string, _home: string) => ({ GIT_ASKPASS: script })],
    ["SSH_ASKPASS", (script: string, _home: string) => ({ SSH_ASKPASS: script })],
    [
      "core.askPass",
      (_script: string, home: string) => ({ GIT_CONFIG_GLOBAL: join(home, "askpass.gitconfig") }),
    ],
  ])(
    "SC25: without a token git gets no credential from the server's %s program",
    async (_label, extra) => {
      const { base, home, script } = await askpassMachine();
      const env = ownerEnv({ ...base, ...extra(script, home) }, home, person);

      const filled = fill(env);

      expect(filled.status).not.toBe(0);
      expect(filled.stdout).not.toContain("password=");
    },
  );

  test("SC25: with a token and an askpass program git still fills the owner's token", async () => {
    const { base, home, script } = await askpassMachine();
    const owner = { ...person, accounts: { github: { id: 1, login: "r", token: "gho_owner" } } };
    const env = ownerEnv({ ...base, GIT_ASKPASS: script, SSH_ASKPASS: script }, home, owner);

    expect(fill(env).stdout).toContain("password=gho_owner");
  });
});
