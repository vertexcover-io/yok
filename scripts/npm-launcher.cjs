#!/usr/bin/env node
// npm's bin for @vertexcover-io/yok: runs the binary from this platform's package.
const { spawnSync } = require("node:child_process");

const pkg = `@vertexcover-io/yok-${process.platform}-${process.arch}`;

let binary;
try {
  binary = require.resolve(`${pkg}/bin/yok`);
} catch {
  console.error(
    `yok: ${pkg} is not installed. yok runs on macOS and Linux, arm64 and x64; ` +
      "reinstall without --no-optional: npm i -g @vertexcover-io/yok",
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
// A binary killed by a signal dies the same way here, so the shell sees the same exit.
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
