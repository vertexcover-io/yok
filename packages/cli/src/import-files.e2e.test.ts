import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCheckout, writeOldHome } from "./test-runs.ts";

const CLI = join(import.meta.dir, "index.ts");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const setup = async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "yok-import-home-")));
  const checkout = gitCheckout("yok-import-app-");
  await writeOldHome(home, checkout);
  // This pipeline exports YOK_RUN_ID; left in, it would leak this run's session into the CLI.
  const { YOK_RUN_ID: _session, ...parentEnv } = process.env;
  const env = { ...parentEnv, YOK_HOME: home };
  const yok = (...args: string[]) => {
    const result = spawnSync("bun", [CLI, ...args], { cwd: checkout, encoding: "utf8", env });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  cleanups.push(() => {
    yok("server", "stop");
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });
  return { yok, checkout, home };
};

describe("yok import-files", () => {
  test("SC718: yok import-files prints the summary, names folderless r-2 on stderr, and yok ls --json then lists r-1 fix-login and not r-2", async () => {
    const { yok, checkout } = await setup();

    const imported = yok("import-files");
    expect(imported.code).toBe(0);
    expect(imported.stdout).toBe(
      "imported users=1 projects=1 runs=1 events=2 comments=1 triggers=1 fires=1 skipped=1 failed=0\n",
    );
    expect(imported.stderr).toBe(
      `skipped run r-2 (old-task): its folder ${checkout}/.yok/old-task is gone\n`,
    );

    const listed = yok("ls", "--json");
    expect(listed.code).toBe(0);
    const { runs } = JSON.parse(listed.stdout);
    expect(runs.map((run: { id: string; name: string | null }) => [run.id, run.name])).toEqual([
      ["r-1", "fix-login"],
    ]);
  }, 40_000);

  test("SC34: a home whose two users share one GitHub account exits 1, names the second user, and keeps users.json with both tokens", async () => {
    const { yok, home } = await setup();
    const users = {
      u_1a2b3c4d: {
        name: "Ana",
        email: "a@x.io",
        accounts: { github: { id: 7, login: "ana", token: "gho_a" } },
      },
      u_5e6f7a8b: {
        name: "Bo",
        email: "b@x.io",
        accounts: { github: { id: 7, login: "ana", token: "gho_b" } },
      },
    };
    writeFileSync(join(home, "users.json"), JSON.stringify(users));

    const imported = yok("import-files");

    expect(imported.code).toBe(1);
    expect(imported.stderr).toContain(
      "failed user u_5e6f7a8b: its github account 7 belongs to user u_1a2b3c4d\n",
    );
    expect(JSON.parse(readFileSync(join(home, "users.json"), "utf8"))).toEqual(users);
  }, 40_000);

  test("SC719: yok --help lists doctor, ls and run, and hides import-files", async () => {
    const { yok } = await setup();

    const help = yok("--help");

    expect(help.code).toBe(0);
    for (const command of ["doctor", "ls", "run"]) expect(help.stdout).toContain(command);
    expect(help.stdout).not.toContain("import-files");
  });
});
