import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IStorage, runDirOf } from "@yok/sdk";
import { memoryStorage } from "@yok/sdk/internal";
import { findRunToRemove } from "./rm.ts";

const gitRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "yok-rm-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
};

const addProjectAt = async (storage: IStorage, name: string, path: string): Promise<void> => {
  const added = await storage.projects.add(name, {
    path,
    addedBy: { channel: "cli" },
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  if (!added.ok) throw new Error(added.error);
};

const addRunIn = (
  storage: IStorage,
  {
    id,
    project,
    name,
    cwd,
  }: Readonly<{ id: string; project: string; name: string | null; cwd: string }>,
) =>
  storage.runs.addRun({
    id,
    project,
    workflow: "ok",
    workflowPath: join(cwd, "ok.yaml"),
    inputs: {},
    sessions: [],
    name,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

describe("findRunToRemove", () => {
  test("SC602: a run id resolves to that run, even one that never got a name", async () => {
    const storage = memoryStorage();
    const web = gitRepo();
    await addProjectAt(storage, "web", web);
    await addRunIn(storage, { id: "r-1a2b3c4d", project: "web", name: null, cwd: web });

    expect(await findRunToRemove(storage, "r-1a2b3c4d", tmpdir())).toEqual({
      ok: true,
      value: "r-1a2b3c4d",
    });
  });

  test("SC603: fix-login in the web checkout resolves to web's run, not api's, though web's .yok/fix-login is gone", async () => {
    const storage = memoryStorage();
    const web = gitRepo();
    const api = gitRepo();
    await addProjectAt(storage, "web", web);
    await addProjectAt(storage, "api", api);
    await addRunIn(storage, { id: "r-web", project: "web", name: "fix-login", cwd: web });
    await addRunIn(storage, { id: "r-api", project: "api", name: "fix-login", cwd: api });
    for (const root of [web, api]) mkdirSync(runDirOf(root, "fix-login"), { recursive: true });
    rmSync(runDirOf(web, "fix-login"), { recursive: true });

    expect(await findRunToRemove(storage, "fix-login", web)).toEqual({ ok: true, value: "r-web" });
  });

  test('SC604: an unknown run fails with no run named "nope" in WEB_REPO, and no run with that id', async () => {
    const storage = memoryStorage();
    const web = gitRepo();
    await addProjectAt(storage, "web", web);

    expect(await findRunToRemove(storage, "nope", web)).toEqual({
      ok: false,
      error: `no run named "nope" in ${web}, and no run with that id`,
    });
  });
});
