import { basename, resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { createGit } from "@yok/sdk";
import { folderSlug, type ProjectView } from "@yok/server";
import { apiErrorText, fail, isRemote, resolveClient } from "./client.ts";

// The folder you are in means nothing on the server, so every --remote command names its project
// and checks it before resolveClient sends anything.
export const PROJECT_REQUIRED = "--project NAME is required with --remote";

const HEADERS = ["NAME", "STATUS", "PATH", "ADDED BY"] as const;

export const renderProjects = (projects: readonly ProjectView[]): string => {
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
    .option("--path <dir>", "a checkout on the server, or where --git clones to; sent as typed")
    .action(async (nameArg, opts, command) => {
      const remote = isRemote(command);
      const fromHere = opts.git === undefined && opts.path === undefined;
      if (fromHere && remote) return fail("--remote needs --path DIR or --git URL");
      const here = fromHere ? await createGit().repoRoot(process.cwd()) : null;
      if (fromHere && here === null) {
        return fail("not inside a git repository; pass --path DIR or --git URL");
      }
      const typed = opts.path === undefined ? undefined : resolve(opts.path);
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
      const client = await resolveClient(remote);
      const added = await client.addProject({
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
    .action(async ({ json }, command) => {
      const client = await resolveClient(isRemote(command));
      const listed = await client.projects();
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
    .action(async (name, opts, command) => {
      const client = await resolveClient(isRemote(command));
      const removed = await client.removeProject(name, opts.purge === true);
      if (!removed.ok) return fail(apiErrorText(removed.error));
      console.log(`removed ${removed.value.removed}`);
      if (removed.value.note !== null) console.log(removed.value.note);
    });

  return project;
};
