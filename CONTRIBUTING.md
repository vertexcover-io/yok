# Contributing to Yok

This file is for people who change yok. If you only want to use it, the [README](./README.md) is enough.

## Read first

The [Yok guide](./docs/guide/README.md) is the onboarding path. Start with [What it is, in 60 seconds](./docs/guide/02-what-it-is.md), then [Setup and first run](./docs/guide/07-setup-and-first-run.md). [How to change it](./docs/guide/08-how-to-change-it.md) has one recipe per kind of change. Architecture decisions live in [docs/adr/INDEX.md](./docs/adr/INDEX.md) and bind future changes.

## Dev setup

You need Bun 1.3.3+, Node 22.12+, tmux 3.3+, git, jq, curl, the GitHub CLI logged in, and Claude Code or Codex.

```bash
git clone https://github.com/vertexcover-io/yok.git
cd yok
bun install
cd packages/cli && bun link && cd ../..
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc
exec zsh
yok-dev --version
```

`yok-dev` runs the TypeScript in this checkout directly, so an edit shows on the next run with no build. It sits beside the release `yok` and never replaces it. `yok-dev run …` starts runs from source, and the agent sessions it starts call `yok-dev` back whenever a skill says `yok`. `yok-dev claude` or `yok-dev codex` opens an agent by hand the same way.

`yok-dev` keeps its runs, server and logs in `~/.yok-dev`, apart from the release's `~/.yok`, so the two never share a server. A run started by one does not show in the other's `yok view`. `YOK_HOME` points either at another folder.

Check the machine with `yok-dev doctor`, then try a run that needs no agent work:

```bash
yok-dev run demo-workflows/step-demo.yaml --prompt "hello" --attach
```

## Repo layout

```
packages/cli      the yok command people type
packages/core     config, run events, state, workspace, the orchestrate commands skills call
packages/server   the local server and the run viewer
packages/sdk      shared primitives and the public @yok/sdk
skills/           one folder per stage or slash command
workflows/        shipped workflows (task.yaml)
demo-workflows/   small workflows that exercise each node type
hooks/            agent hook handlers
docs/guide        onboarding guide
docs/adr          architecture decisions
```

`CLAUDE.md` and `AGENTS.md` hold the coding rules every agent session in this repo follows. Read them before writing code.

## Before you open a PR

```bash
bun run check        # typecheck, lint and all tests, one JSON summary
```

Or one at a time: `bun run typecheck`, `bun run lint`, `bun test packages/core`. Tests sit beside the code they test. `*.test.ts` are unit tests. `*.e2e.test.ts` drive the real commands against a temporary repo and take longer.

Inside a `.worktrees/` checkout, `bun run lint` finds no files because `biome.json` excludes that path. Lint from the main checkout, or use a temporary Biome config without the exclusion.

Commits follow the conventional commit format. A decision that will shape later changes gets an ADR via `/adr`.

## Releases

Releases are cut from `main`. In GitHub, go to Actions, pick Release, and run the workflow. Choose the bump (`patch`, `minor`, `major`, or `none` to count up the current release candidate) and tick pre-release for an `-rc.N` version. The workflow bumps every manifest, pins both marketplaces to the new tag, builds the four binaries, checks the Linux one on a machine without bun, publishes the release, and test-installs it on Linux and macOS.

Or cut one locally and push it:

```bash
bun run release:version patch --pre-release   # 0.0.1 -> 0.0.2-rc.1
bun run release:version --pre-release         # 0.0.2-rc.1 -> 0.0.2-rc.2
bun run release:version patch                 # 0.0.2-rc.2 -> 0.0.2
git push origin main --follow-tags
```

The binary and the plugin ship at the same version and `yok doctor` refuses to run when they differ, so a release always moves both.
