import { basename, resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { createGit } from "@yok/sdk";
import type { ProjectView } from "@yok/server";
import { apiErrorText, ensureServer, fail, remoteUrl, yokClient } from "./client.ts";

// "Refrens_Main" -> "refrens-main"; empty or digit-first when the folder has no usable name.
export const folderSlug = (folder: string): string =>
  folder
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const HEADERS = ["NAME", "STATUS", "PATH", "ADDED BY"] as const;

const renderProjects = (projects: readonly ProjectView[]): string => {
  const rows = projects.map((p) => [p.name, p.status, p.path, p.addedBy.name ?? p.addedBy.channel]);
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, column) => value.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(HEADERS), ...rows.map(line)].join("\n");
};

export const projectCommand = () => {
  const project = new Command("project").description("Manage the checkouts the server runs on");

  project
    .command("add")
    .description("Register a checkout on the server, or clone one")
    .argument("[name]", "project name (default: from the folder or the repository)")
    .option("--git <url>", "clone this repository (https or ssh)")
    .option("--path <dir>", "a checkout on the server, or where --git clones to")
    .action(async (nameArg, opts) => {
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
      const folder = basename(path ?? opts.git ?? "");
      const name = nameArg ?? folderSlug(folder);
      if (nameArg !== undefined && !/^[a-z]/.test(nameArg)) {
        return fail(
          `"${nameArg}" is not a valid project name: use lowercase letters, digits and dashes, starting with a letter`,
        );
      }
      if (!/^[a-z]/.test(name)) {
        return fail(`cannot name the project from "${folder}"; pass a NAME`);
      }
      await ensureServer();
      const added = await yokClient().addProject({
        name,
        ...(opts.git === undefined ? {} : { git: opts.git }),
        ...(path === undefined ? {} : { path }),
        addedBy: { channel: "cli" },
      });
      if (!added.ok) return fail(apiErrorText(added.error));
      const { project: saved } = added.value;
      console.log(`added ${saved.name}  ${saved.path}`);
    });

  project
    .command("list")
    .description("List the server's projects")
    .option("--json", "print the reply as JSON")
    .action(async ({ json }) => {
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
    });

  project
    .command("remove")
    .description("Forget a project; --purge also deletes a folder yok cloned")
    .argument("<name>", "project name")
    .option("--purge", "delete the folder too, when yok cloned it")
    .action(async (name, opts) => {
      await ensureServer();
      const removed = await yokClient().removeProject(name, opts.purge === true);
      if (!removed.ok) return fail(apiErrorText(removed.error));
      console.log(`removed ${removed.value.removed}`);
      if (removed.value.note !== null) console.log(removed.value.note);
    });

  return project;
};
