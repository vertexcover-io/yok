import { Command } from "@commander-js/extra-typings";
import { findRoot, type IStorage, type Result, yokHome } from "@yok/sdk";
import { belongsTo, withStorage } from "@yok/sdk/internal";
import { apiErrorText, ensureServer, fail, yokClient } from "./client.ts";

// RUN is a run id, else the name of a run in this checkout. Neither lookup needs the run's
// folder, so a run whose folder was deleted by hand is still found.
export const findRunToRemove = async (
  storage: IStorage,
  run: string,
  cwd: string,
): Promise<Result<string>> => {
  if ((await storage.runs.findRun(run)) !== undefined) return { ok: true, value: run };
  const root = await findRoot(cwd);
  if (!root.ok) return { ok: false, error: `no run with id ${run}, and ${root.error}` };
  const named = await storage.runs.findRunsByName(run);
  const owned = await Promise.all(named.map((candidate) => belongsTo(candidate, root.value)));
  const found = named.find((_candidate, index) => owned[index]);
  if (found === undefined) {
    return { ok: false, error: `no run named "${run}" in ${root.value}, and no run with that id` };
  }
  return { ok: true, value: found.id };
};

export const rmCommand = () =>
  new Command("rm")
    .description("Delete a finished run: its record, its .yok folder and any session left open")
    .argument("<run>", "run name in this repo, or a run id")
    .action(async (run) => {
      const id = await withStorage(yokHome(), (storage) =>
        findRunToRemove(storage, run, process.cwd()),
      );
      if (!id.ok) return fail(id.error);
      await ensureServer();
      const removed = await yokClient().removeRun(id.value);
      if (!removed.ok) return fail(apiErrorText(removed.error));
      console.log(`removed ${removed.value.removed}`);
    });
