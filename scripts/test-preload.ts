import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests leave their temp folders behind, and once the system temp folder holds hundreds of
// thousands of them every bun the e2e tests start there loads several times slower. Each run
// gets a fresh folder, inherited by the processes it spawns. Under --parallel each file loads this
// preload in a worker that never exits, so the folder goes when the file's tests end.
const testTmp = realpathSync(mkdtempSync(join(tmpdir(), "yok-test-")));
process.env.TMPDIR = testTmp;
afterAll(() => rmSync(testTmp, { recursive: true, force: true }));

// Launching an agent adds its folder to the agent's trusted list, so tests get configs of their
// own and never write the person's ~/.claude.json or ~/.codex/config.toml.
process.env.CLAUDE_CONFIG_DIR = join(testTmp, "claude-config");
process.env.CODEX_HOME = join(testTmp, "codex-home");

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

// The stop that ends a run's finishing turn kills the run's registered terminal on yok's tmux
// server, so tests get a server of their own and never reach the person's real sessions; a test
// that drives tmux passes its own.
process.env.YOK_TMUX_SOCKET ??= `yok-test-${process.pid}`;
