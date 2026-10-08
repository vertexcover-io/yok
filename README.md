<h1 align="center">Yok</h1>

<p align="center">
  <strong>Engineering discipline for AI-assisted development</strong><br>
  A Claude Code and Codex plugin that adds the engineering your AI skips: design docs before code, tests before implementation, quality gates before merging
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="Platform: macOS and Linux">
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-plugin-blueviolet" alt="Claude Code plugin"></a>
  <img src="https://img.shields.io/badge/Codex-plugin-111111" alt="Codex plugin">
</p>

<p align="center">
  <a href="#requirements">Requirements</a> &nbsp;·&nbsp;
  <a href="#installation"><b>Installation</b></a> &nbsp;·&nbsp;
  <a href="#project-setup">Project setup</a> &nbsp;·&nbsp;
  <a href="#usage">Usage</a> &nbsp;·&nbsp;
  <a href="#commands">Commands</a> &nbsp;·&nbsp;
  <a href="#skills">Skills</a> &nbsp;·&nbsp;
  <a href="#learn-more">Learn more</a>
</p>

## What it is

AI coding tools are fast. They are also reckless: no tests, no design, no verification. Yok takes a task and a coding agent, and walks the agent through a workflow of stages until a pull request is open. Every stage has clear inputs, outputs, and pass/fail checks, and every step is written to an event log.

```
Ticket → Workspace → Baseline → Design → Plan → Implement → Review → QA → Commit → PR → Retro
```

You type one command. The engine decides what comes next, checks each stage's result with code, and keeps the agent moving when nobody is watching. Run the whole workflow, or use the individual skills (`/tdd`, `/code-review`, `/git-commit`) inside a normal agent session.

To understand how it works and why it is built this way, read the [Yok guide](./docs/guide/README.md). [What it is, in 60 seconds](./docs/guide/02-what-it-is.md) is the one-minute version.

## Requirements

macOS or Linux. The `yok` binary has no runtime of its own, but a run uses these tools:

| Tool | Needed for | Install |
|---|---|---|
| Claude Code or Codex | the agent | see claude.com/claude-code, or `npm i -g @openai/codex` |
| tmux 3.3 or newer | every agent session lives in a tmux window | `brew install tmux` |
| git | the run works in a git worktree | `brew install git` |
| GitHub CLI, logged in | the PR stage | `brew install gh && gh auth login` |
| jq, curl | shell steps inside skills | `brew install jq curl` |
| ffmpeg, agent-browser | the QA stage films proof of the feature | `brew install ffmpeg`, `npm i -g agent-browser && agent-browser install` |

`yok doctor` checks all of these and tells you what is missing.

## Installation

### 1. Install the binary and the plugin

yok is private, so installing it needs the GitHub CLI logged in with an account that can see `vertexcover-io/yok`. `gh auth setup-git` lets git use that login too, which the plugin install needs.

```bash
gh auth login
gh auth setup-git
gh api repos/vertexcover-io/yok/contents/install.sh -H "Accept: application/vnd.github.raw" | sh
```

This downloads the `yok` binary for your machine, verifies it against the release's `checksums.txt`, installs it to `~/.yok/bin`, adds that folder to `PATH` in your shell's start file, and installs the yok plugin into every agent it finds (`claude`, `codex`).

Options:

- `YOK_VERSION=v0.0.2-rc.1` installs one exact release.
- `YOK_AGENTS=claude` limits the plugin install to one agent.

### 2. Check it

Open a new shell, then:

```bash
yok --version
yok doctor
```

The doctor prints one row per check marked `OK`, `WARN`, or `FAIL`, with the first fix step beside each. Fix every `FAIL`.

### 3. Codex only: merge the config

Codex needs subagent concurrency and the yok permissions profile in its config:

```bash
mkdir -p ~/.codex
cat references/codex-config.toml >> ~/.codex/config.toml
```

Tool names differ between Claude Code and Codex. The mapping is in [references/codex-tools.md](./references/codex-tools.md).

### Upgrading

Run the install command again, or:

```bash
yok update --agent claude                 # newest stable release, plugin moved with it
yok update --agent claude --pre-release   # release candidates too
```

`yok update` reads `GH_TOKEN`, else `GITHUB_TOKEN`, else the token `gh auth token` prints.

The binary and the plugin always ship at the same version. `yok doctor` and `yok run` stop when they differ. `yok plugin install --agent claude` puts the plugin back at the binary's version. Running agent sessions keep the old skills until `/reload-plugins` or a restart.

## Project setup

Do this once per repository.

1. **Add the config.** Create `orchestrate.config.yaml` at the repository root. It names the baseline command, the worktree layout, the notifier, and each package's typecheck, lint and test commands. This repo's own [orchestrate.config.yaml](./orchestrate.config.yaml) is a working example.

   ```yaml
   version: 2
   baseline: bun run check
   workspace:
     layout: mono
     path: .worktrees/{{ branch }}
     baseBranch: main
     setup: bun install
   packages:
     app:
       path: .
       runner: bun
       commands:
         typecheck: bun run typecheck
         lint: bun run lint
         testAll: bun test
         testFile: bun test {FILE}
   ```

2. **Add secrets.** Put `LINEAR_API_KEY` or `ASANA_API_KEY` in a `.env` file at the repository root if your tasks come from tickets. Slack notifications need `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`.

3. **Ignore run output.** Add `.yok/*` to `.gitignore`. Run artifacts land there.

4. **Check the project.**

   ```bash
   yok doctor --workflow task
   ```

   This runs the machine checks plus the ones the `task` workflow declares.

## Usage

### Run the task workflow

```bash
yok run task --prompt "Add rate limiting to the API"
```

`yok run` starts the yok server, opens an agent session in tmux, and sends it the `orchestrate` skill. It prints a run id, an attach command, and a URL, opens the run's page in your browser, and puts your terminal in the agent's session. Pass `--no-attach` to get your terminal back right away.

The design and planning stages ask you questions in the agent's terminal and show you pages to approve. After that it runs on its own. A full run takes about an hour.

### Watch a run

```bash
yok attach RUN_NAME                   # the agent's terminal; detach with Ctrl-b d
yok view RUN_NAME                     # reopen the run's page in the browser
yok run task --prompt "…" --no-attach # start without attaching
```

### What you get

- A branch in a worktree under `.worktrees/`, with tidy conventional commits.
- An open pull request with a visual change outline and a proof report.
- A folder `.yok/RUN_NAME/` holding the design, the plan, the baseline, the QA proof, and the full event log.
- A retro report that says what yok itself should do better next time.

### What the task workflow does

`task` ships with yok. It runs these stages, each one a skill under `skills/`:

```
ticket-fetcher → create-workspace → baseline → design → planning → implement
  → code-review → qa (loops back to implement until it passes, up to 4 times)
  → git-commit → visual-pr → retro (runs after a failed stage too)
```

`ticket-fetcher` picks its provider from the ticket URL or key in the prompt: Linear or Asana. If QA ends `BLOCKED` because it could not verify the change, the commit and PR stages are skipped, so nothing unverified is published.

### Run your own workflow

A workflow is a YAML file of nodes. A bare name runs a shipped workflow. A path, or a name ending in `.yaml` or `.yml`, runs that file from your project:

```bash
yok run ./my-flow.yaml --prompt "…"
yok verify ./my-flow.yaml              # compile it and print the first error
yok doctor --workflow ./my-flow.yaml   # also run the checks it declares
```

[workflows/task.yaml](./workflows/task.yaml) is the full example. The `demo-workflows/` folder has smaller ones that show each node type.

### Try it without the notifier

To run with a project's Slack notifier turned off, pass a local config:

```bash
printf 'version: 2\nnotifier: { enabled: false }\n' > /tmp/yok-local.yaml
yok run task --prompt "…" --config /tmp/yok-local.yaml
```

## Commands

| Command | What it does |
|---|---|
| `yok run WORKFLOW --prompt TEXT` | Start a run. `--name`, `--input key=value`, `--config FILE`, `--no-attach`, `--no-open` |
| `yok attach [NAME]` | Attach to a run's agent terminal. `--run-id ID`, `--print` |
| `yok view [NAME]` | Open a run's page in the browser. `--run-id ID`, `--print` |
| `yok verify WORKFLOW` | Compile a workflow and report the first error |
| `yok doctor` | Check the tools, repository and config a run needs. `--json`, `--workflow` |
| `yok server start \| status \| stop` | Manage the local server. Stopping it leaves tmux sessions running |
| `yok update --agent NAME` | Install the newest release and move the plugin to it. `--pre-release` |
| `yok plugin install --agent NAME` | Reinstall the plugin at the binary's version |
| `yok types` | Write the SDK's type files to `.yok/types/` for your editor |
| `yok claude` / `yok codex` | Open an agent session by hand with the yok plugin loaded |
| `yok orchestrate …` | Called by skills during a run, not typed by hand |

## Skills

Skills work on their own inside any Claude Code or Codex session, with or without a run.

| Command | What it does |
|---|---|
| `/planning` | Breaks work into phases with a dependency graph |
| `/adr` | Records one architecture decision in `docs/adr/` and adds it to the index |
| `/tdd` | RED-GREEN-REFACTOR development cycle |
| `/implement` | Manual coding entry point: TDD plus code-quality, review when green |
| `/code-review` | Reviews a diff across eight axes, writes a verdict to `REVIEW.md`, then applies the fixes |
| `/git-commit` | Groups changes into logical conventional commits |
| `/visual-pr` | Creates or updates a PR with a visual change outline and validation evidence |
| `/refactor` | Assesses code for extraction, simplification and naming improvements, then applies them |
| `/retro` | Audits a finished run's transcripts and writes a ranked report of yok defects |
| `/resolve-merge-conflict` | Resolves a stopped merge or rebase, or a conflicting PR, by recovering each side's intent |

Three skills run automatically with no command: `code-quality` (strict types, immutability, pure functions, early returns), `refactor` (after tests go green), and `writing-style` (any prose a person will read).

## Extending yok

A project can extend yok without forking it. Verifiers, subscribers and schema modules are TypeScript files in your project that import `@yok/sdk` and `zod`. The binary answers both imports itself, so you install neither. For your editor and `tsc`, run `yok types` and add one path mapping to `tsconfig.json`:

```jsonc
{ "compilerOptions": { "paths": { "@yok/sdk": ["./.yok/types/index.d.ts"] } } }
```

A project can also replace one of a shipped skill's scripts, react to run events with its own subscribers, or add a stage of its own. [How to change it](./docs/guide/08-how-to-change-it.md) has one recipe per kind of change.

## Learn more

- [The Yok guide](./docs/guide/README.md): why it exists, what it is, the core principles, the architecture, and one task followed end to end.
- [GLOSSARY.md](./GLOSSARY.md): the project's words, one line each.
- [docs/adr/INDEX.md](./docs/adr/INDEX.md): every architecture decision and why.

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) covers the dev setup, the checks to run, and how releases are cut.

## Inspiration

The skills and CLAUDE.md in this repo were heavily inspired by these projects:

- [obra/superpowers](https://github.com/obra/superpowers): the primary reference for many of the skills here (TDD, code quality, planning, brainstorm, refactor, testing, and more).
- [coelhoxyz/claude-code-global-config](https://github.com/coelhoxyz/claude-code-global-config): inspired the global CLAUDE.md structure and approach to shaping Claude Code's behavior across projects.
- [abhishekray07/claude-md-templates](https://github.com/abhishekray07/claude-md-templates/blob/main/global/CLAUDE.md): another reference for CLAUDE.md patterns, particularly around workflow preferences and coding style directives.
- [citypaul/.dotfiles/claude](https://github.com/citypaul/.dotfiles/tree/main/claude/.claude): a well-organized Claude Code configuration that served as a reference for the overall repo layout and settings.
