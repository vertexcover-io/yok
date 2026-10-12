import { join } from "node:path";

// Tests run outside the yok CLI, so they set what its entry sets when run from source.
process.env.YOK_SELF ??= JSON.stringify([
  process.execPath,
  "--no-env-file",
  join(import.meta.dir, "..", "packages", "cli", "src", "index.ts"),
]);

// Started inside a yok session, a test would see its pane and run: `orchestrate init` renames
// whatever pane $TMUX_PANE names, and `skill run` loads whatever run $YOK_RUN_ID names. A test
// that needs either passes its own.
for (const name of ["TMUX", "TMUX_PANE", "YOK_RUN_ID"]) delete process.env[name];
