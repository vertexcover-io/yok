import { userInfo } from "node:os";
import { basename, resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { createGit } from "@yok/sdk";
import {
  exitCodeFor,
  nameProject,
  projectAddDefinition,
  projectListDefinition,
  projectRemoveDefinition,
  renderProjects,
  renderText,
} from "@yok/server";
import { apiErrorText, ensureServer, fail, remoteUrl, yokClient } from "./client.ts";

export const projectCommand = () => {
  const project = new Command("project").description("Manage the checkouts the server runs on");

  project.addCommand(
    projectAddDefinition().action(async (nameArg, opts) => {
      const fromHere = opts.git === undefined && opts.path === undefined;
      // A remote server's folders are not this machine's: --path goes as typed, and the server
      // refuses a relative one.
      const remote = remoteUrl() !== null;
      if (remote && fromHere) {
        return fail("the server is remote: pass --path DIR (a folder on the server) or --git URL");
      }
      const here = fromHere ? await createGit().repoRoot(process.cwd()) : null;
      if (fromHere && here === null) {
        return fail("not inside a git repository; pass --path DIR or --git URL");
      }
      const typed = remote || opts.path === undefined ? opts.path : resolve(opts.path);
      const path = typed ?? here ?? undefined;
      const name = nameProject(nameArg, basename(path ?? opts.git ?? ""));
      if (!name.ok) return fail(name.error);
      await ensureServer();
      const added = await yokClient().addProject({
        name: name.value,
        ...(opts.git === undefined ? {} : { git: opts.git }),
        ...(path === undefined ? {} : { path }),
        addedBy: { channel: "cli", name: userInfo().username },
      });
      if (!added.ok) return fail(apiErrorText(added.error));
      const { project: saved, findings } = added.value;
      console.log(`added ${saved.name}  ${saved.path}\n`);
      console.log(renderText(findings));
      process.exitCode = exitCodeFor(findings);
    }),
  );

  project.addCommand(
    projectListDefinition().action(async ({ json }) => {
      await ensureServer();
      const listed = await yokClient().projects();
      if (!listed.ok) return fail(apiErrorText(listed.error));
      if (json === true) return console.log(JSON.stringify(listed.value, null, 2));
      const { projects } = listed.value;
      console.log(
        projects.length === 0
          ? "no projects; add one with yok project add"
          : renderProjects(projects),
      );
    }),
  );

  project.addCommand(
    projectRemoveDefinition().action(async (name, opts) => {
      await ensureServer();
      const removed = await yokClient().removeProject(name, opts.purge === true);
      if (!removed.ok) return fail(apiErrorText(removed.error));
      console.log(`removed ${removed.value.removed}`);
      if (removed.value.note !== null) console.log(removed.value.note);
    }),
  );

  return project;
};
