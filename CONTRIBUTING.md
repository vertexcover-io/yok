# Contributing to Yok

This file is for people who change yok. If you only want to use it, the [README](./README.md) is enough.

Yok is built with yok. The normal way to make a change here is to start a run on this repo and let the pipeline take it to a PR. You review the design, the plan and the PR along the way.

## Read the guide first

The [Yok guide](./docs/guide/README.md) is the onboarding path for this repo. This file is the short version, and links into the guide for everything else. Read the pages in this order the first time:

| Page | Read it to learn |
|---|---|
| [Why it exists](./docs/guide/01-why-it-exists.md) | what went wrong with version one, and what yok is trying to get right |
| [What it is, in 60 seconds](./docs/guide/02-what-it-is.md) | the one picture and the five things to know |
| [Core principles](./docs/guide/03-core-principles.md) | the rules every change is checked against |
| [Architecture](./docs/guide/04-architecture.md) | the packages, processes and files, and where each kind of change goes |
| [One task, end to end](./docs/guide/05-one-task-end-to-end.md) | one real run followed hop by hop, with the code behind each hop |
| [Concepts](./docs/guide/06-concepts.md) | workflow, node, stage, artifact, event, subscriber, tier and the rest |
| [Setup and first run](./docs/guide/07-setup-and-first-run.md) | the full dev setup, with checks after each step |
| [How to change it](./docs/guide/08-how-to-change-it.md) | one recipe per kind of change |

Two more references sit beside the guide. [GLOSSARY.md](./GLOSSARY.md) has the project's words and the words to avoid. [docs/adr/INDEX.md](./docs/adr/INDEX.md) lists every architecture decision, and those decisions bind future changes.

Before writing code, read [CLAUDE.md](./CLAUDE.md). It has the style rules every person and agent follows here, including test-first development.

## Set up a dev build

You need Bun 1.3.3+, Node 22.12+, tmux 3.3+, git, jq, curl, the GitHub CLI logged in, and Claude Code or Codex. The README's requirements table has install commands for macOS and Linux.

```bash
git clone https://github.com/vertexcover-io/yok.git
cd yok
bun install
cd packages/cli && bun link && cd ../..
```

Then put Bun's bin folder on your `PATH`. Use `~/.zshrc` for zsh or `~/.bashrc` for bash:

```bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc
exec $SHELL
yok-dev --version
yok-dev doctor
```

`yok-dev` runs the TypeScript in this checkout directly, so an edit shows on the next run with no build. Every `yok-dev run` or `yok-dev view` restarts a server that started before it, so the server runs your latest code too. It sits beside the release `yok` and never replaces it. The agent sessions it starts call `yok-dev` back whenever a skill says `yok`, and Claude loads this checkout as its plugin.

`yok-dev` keeps its runs, server and logs in `~/.yok-dev`, apart from the release's `~/.yok`. A run started by one does not show in the other. [Setup and first run](./docs/guide/07-setup-and-first-run.md) walks through the setup, the first demo runs, and what to do when something breaks.

## Make a change with yok

Use `yok-dev` on this repo to build changes to yok. Run it from the root of your checkout:

```bash
yok-dev run task --prompt "Describe the change, or paste a Linear ticket URL"
```

- **`task`** runs the full pipeline: design, plan, implement, review, QA with proof, commit and PR. Use it for features and anything that needs thought first.
- **`quick`** skips baseline, design, planning and QA. Use it for small, well-understood changes such as a bug fix with a clear cause or a docs edit.

```bash
yok-dev run quick --prompt "Fix the typo in the doctor's tmux message"
```

What to know before your first run on this repo:

- **The config is already here.** [orchestrate.config.yaml](./orchestrate.config.yaml) sets the baseline, the worktree path under `.worktrees/`, and each package's commands.
- **The Slack notifier is on.** Put `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` in `.env` at the repo root, or pass a local config with the notifier off. [Setup and first run](./docs/guide/07-setup-and-first-run.md) shows how.
- **Tickets need a key.** A Linear URL needs `LINEAR_API_KEY` in `.env`. A plain prompt needs nothing.
- **Commit and PR happen without asking.** In a `yok run`, the `git-commit` and `visual-pr` stages commit, push and open the PR on their own. Everywhere else in this repo, ask before committing.
- **Read the retro.** The last stage of `task` audits the run for yok defects. A finding there is often your next change.

You can also make a change by hand. Use the skills directly in a Claude Code session, such as `/yok:implement` and `/yok:code-review`, and the same checks below apply.

## Find the recipe for your change

[How to change it](./docs/guide/08-how-to-change-it.md) has a recipe for each common change. Each one says where the code goes, what else must move with it, and how to prove it works.

| You want to | Recipe |
|---|---|
| Add a stage | [Add a stage](./docs/guide/08-how-to-change-it.md#add-a-stage) |
| Change a stage for one project only | [Change a shipped stage for one project only](./docs/guide/08-how-to-change-it.md#change-a-shipped-stage-for-one-project-only) |
| Add something a skill does to a run | [Add an action a skill can take on a run](./docs/guide/08-how-to-change-it.md#add-an-action-a-skill-can-take-on-a-run) |
| Add a `yok` command | [Add a command a person types](./docs/guide/08-how-to-change-it.md#add-a-command-a-person-types) |
| Add an event type | [Add a fact to the record](./docs/guide/08-how-to-change-it.md#add-a-fact-to-the-record) |
| Change which node runs next | [Change how the next node is chosen](./docs/guide/08-how-to-change-it.md#change-how-the-next-node-is-chosen) |
| Add a node type | [Add a node type](./docs/guide/08-how-to-change-it.md#add-a-node-type) |
| Add or change an agent hook | [Add or change an agent hook handler](./docs/guide/08-how-to-change-it.md#add-or-change-an-agent-hook-handler) |
| Record a decision | [Record a decision](./docs/guide/08-how-to-change-it.md#record-a-decision) |

The first question for any change comes from [Core principles](./docs/guide/03-core-principles.md). Is it a decision, a performance, or a record? Decisions go in the engine, performances go in skills, and records go through events.

Each skill folder has a README.md that says what the skill does and which files it holds. Start there before you open its SKILL.md.

## Repo layout

```
packages/cli          the yok command people type
packages/core         config, workflows, run events and state, the orchestrate commands skills call
packages/server       the local server and the run viewer
packages/sdk          shared primitives and the public @yok/sdk
skills/               one folder per stage or slash command, each with a README.md and SKILL.md
workflows/            shipped workflows: task.yaml and quick.yaml
demo-workflows/       small workflows that exercise each node type
scripts/              repo scripts: the check summary, SDK types, release versioning and smoke tests
references/           Codex config snippet and tool-name mapping
.claude-plugin/       Claude Code plugin manifest
.codex-plugin/        Codex plugin manifest
.agents/plugins/      Codex marketplace catalog
docs/guide/           onboarding guide
docs/adr/             architecture decisions
```

[Architecture](./docs/guide/04-architecture.md) explains each package and which one a change belongs in.

## Before you open a PR

```bash
bun run check        # typecheck, lint and all tests, one JSON summary
```

The bar is zero typecheck errors, zero lint errors, and zero failed tests. While you work, run one piece at a time:

```bash
bun run typecheck
bun run lint
bun test packages/core
bun test packages/core/src/workflow/next.test.ts
```

Tests sit beside the code they test. `*.test.ts` files are unit tests. `*.e2e.test.ts` files drive the real commands against a temporary repo and home, and take longer. The testing standard is [skills/tdd/references/testing.md](./skills/tdd/references/testing.md), with [anti-patterns.md](./skills/tdd/references/anti-patterns.md) beside it. It applies to this repo too.

Inside a `.worktrees/` checkout, `bun run lint` finds no files because `biome.json` excludes that path. Lint from the main checkout, or use a temporary Biome config without the exclusion.

Then follow the normal flow. Make a branch, write conventional commits, and open a PR with a change outline. The `/yok:git-commit` and `/yok:visual-pr` skills do both.

If your change picks one way over another and later code must follow it, record an ADR with `/yok:adr`. The planning stage reads the ADR index, so a recorded decision is one the agent will respect. When you add a word people will say out loud, add it to [GLOSSARY.md](./GLOSSARY.md).

## Releases

Releases are cut from `main`. In GitHub, go to Actions, pick Release, and run the workflow. Choose the bump: `patch`, `minor`, `major`, or `none` to count up the current release candidate. Tick pre-release for an `-rc.N` version.

The workflow bumps every manifest and pins both marketplaces to the new tag. It builds the four binaries, checks the Linux one on a machine without bun, publishes the release, and test-installs it on Linux and macOS.

You can also cut one locally and push it:

```bash
bun run release:version patch --pre-release   # 0.0.1 -> 0.0.2-rc.1
bun run release:version --pre-release         # 0.0.2-rc.1 -> 0.0.2-rc.2
bun run release:version patch                 # 0.0.2-rc.2 -> 0.0.2
git push origin main --follow-tags
```

The binary and the plugin ship at the same version, and `yok doctor` refuses to run when they differ. A release always moves both.
