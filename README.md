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
  <a href="#your-first-run">First run</a> &nbsp;·&nbsp;
  <a href="#workflows">Workflows</a> &nbsp;·&nbsp;
  <a href="#commands">Commands</a> &nbsp;·&nbsp;
  <a href="#skills">Skills</a> &nbsp;·&nbsp;
  <a href="#learn-more">Learn more</a>
</p>

## What it is

AI coding tools are fast and careless: no design, no tests, no proof the change works. Yok takes a task and a coding agent (Claude Code or Codex) and walks the agent through a workflow of stages until a pull request is open. Each stage has clear inputs, outputs and pass/fail checks, and every step is written to an event log.

```
Ticket → Workspace → Baseline → Design → Plan → Implement → Review → QA → Commit → PR → Retro
```

You type one command. The engine decides what comes next, checks each stage's result with code, and keeps the agent moving when nobody is watching. A workflow is a YAML file: yok ships two, and you can write your own ([Workflows](#workflows)). Each stage is a skill you can also call on its own inside a normal agent session ([Skills](#skills)).

Yok is a private repository. Installing it needs a GitHub account that can see `vertexcover-io/yok`.

For the reasons behind the design, read the [Yok guide](./docs/guide/README.md). [What it is, in 60 seconds](./docs/guide/02-what-it-is.md) is the one-minute version.

## Requirements

Yok runs on macOS and Linux, arm64 and x64. The `yok` binary has no runtime of its own, but a run uses these tools. Install the ones you are missing, then let `yok doctor` confirm.

| Tool | Needed for | macOS | Debian / Ubuntu |
|---|---|---|---|
| Claude Code or Codex | the agent | `npm install -g @anthropic-ai/claude-code` or `npm i -g @openai/codex` | same |
| GitHub CLI, logged in | installing yok, and the PR stage | `brew install gh` | see [GitHub's Linux install page](https://github.com/cli/cli/blob/trunk/docs/install_linux.md) |
| git | the run works in a git worktree | `brew install git` | `sudo apt install git` |
| tmux 3.3 or newer | every agent session lives in a tmux window | `brew install tmux` | `sudo apt install tmux` on Ubuntu 24.04 or newer; 22.04 ships 3.2a, so build from source there |
| Bun | the scripts the `task` workflow's skills run | `brew install oven-sh/bun/bun` | `curl -fsSL https://bun.sh/install \| bash` |
| jq, curl | shell steps inside skills | `brew install jq curl` | `sudo apt install jq curl` |
| ffmpeg, agent-browser | the QA stage films proof of the feature | `brew install ffmpeg`, then `npm i -g agent-browser && agent-browser install` | `sudo apt install ffmpeg`, then the same npm commands |

## Installation

### 1. Install the binary and the plugin

Log in to GitHub with an account that can see `vertexcover-io/yok`, let git use that login too (the plugin install clones the repo), then run the installer:

```bash
gh auth login
gh auth setup-git
gh api repos/vertexcover-io/yok/contents/install.sh -H "Accept: application/vnd.github.raw" | sh
```

The installer downloads the `yok` binary for your OS and CPU, checks it against the release's `checksums.txt`, puts it in `~/.yok/bin`, adds that folder to `PATH` in `~/.zshrc`, `~/.bashrc` or `~/.profile` (whichever matches your shell), and installs the yok plugin into every agent it finds (`claude`, `codex`).

Options, set as environment variables before the command:

- `YOK_VERSION=v0.0.2-rc.1` installs one exact release instead of the newest.
- `YOK_AGENTS=claude` limits the plugin install to one agent.

#### Or with Homebrew or npm

Both install only the binary. The plugin install still clones `vertexcover-io/yok`, so the `gh auth` steps above still apply.

```bash
brew install vertexcover-io/tap/yok      # or: npm i -g @vertexcover-io/yok
yok plugin install --agent claude
```

### 2. Check it

Open a new shell, then:

```bash
yok --version
yok doctor
```

The doctor prints one row per check marked `OK`, `WARN` or `FAIL`, with the first fix step beside each. Fix every `FAIL`. A `WARN` costs you the one stage it unblocks (for example, no `ffmpeg` means no filmed QA proof).

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
yok update --agent claude                 # newest stable release; the plugin moves with it
yok update --agent claude --pre-release   # release candidates too
```

On a Homebrew or npm install, `yok update` runs `brew upgrade yok` or `npm install -g @vertexcover-io/yok@latest` (`@next` with `--pre-release`; Homebrew has stable releases only) and then does the same plugin move and server restart. After a plain `brew upgrade` or `npm i -g`, run `yok plugin install --agent claude` yourself; the next `yok` command that needs the server replaces the one still running the old version.

`yok update` reads `GH_TOKEN`, else `GITHUB_TOKEN`, else the token `gh auth token` prints. A running server is restarted on the new binary; its tmux sessions keep running.

The binary and the plugin always ship at the same version, and `yok doctor` and `yok run` stop when they differ. `yok plugin install --agent claude` puts the plugin back at the binary's version. Agent sessions that are already open keep the old skills until `/reload-plugins` or a restart.

## Project setup

Do this once per repository.

1. **Add the config.** Create `orchestrate.config.yaml` at the repository root. It names the baseline command, the worktree layout, and each package's typecheck, lint and test commands. This repo's own [orchestrate.config.yaml](./orchestrate.config.yaml) is a working example.

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

2. **Add secrets, if you need them.** Put `LINEAR_API_KEY` or `ASANA_API_KEY` in a `.env` file at the repository root if your prompts name tickets. Slack notifications need `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`. A plain prompt needs neither.

3. **Ignore run output.** Add `.yok/` to `.gitignore`. Run artifacts land there.

4. **Check the project.**

   ```bash
   yok doctor --workflow task
   ```

   This runs the machine checks plus the ones the `task` workflow declares.

## Your first run

Start in the repository you set up:

```bash
yok run task --prompt "Add rate limiting to the API"
```

`yok run` starts the yok server, opens an agent session in tmux, and hands it the task. It prints the run id, an attach command and the run's page URL, opens that page in your browser, and puts your terminal inside the agent's session. Detach with `Ctrl-b d`; pass `--no-attach` to keep your terminal from the start.

When it finishes you have:

- a branch in a worktree under `.worktrees/`, with tidy conventional commits;
- an open pull request with a visual change outline and a proof report;
- a folder `.yok/RUN_NAME/` holding the design, the plan, the baseline, the QA proof and the full event log;
- a retro report that says what yok itself should do better next time.

To watch a run later:

```bash
yok attach RUN_NAME    # the agent's terminal; detach with Ctrl-b d
yok view RUN_NAME      # reopen the run's page in the browser
```

[One task, end to end](./docs/guide/05-one-task-end-to-end.md) follows a real run hop by hop and names the code behind each one.

## Workflows

A workflow is a YAML file of nodes. Yok ships two, `task` and `quick`. A bare name runs a shipped one; a path, or a name ending in `.yaml` or `.yml`, runs a file from your project.

### task: the full pipeline

[workflows/task.yaml](./workflows/task.yaml) runs eleven stages. Each one is a skill under `skills/`.

| Stage | What it does | What it needs |
|---|---|---|
| `ticket-fetcher` | Turns your prompt into the task. A plain prompt passes through unchanged; a Linear or Asana URL or key is fetched into a ticket bundle. | `LINEAR_API_KEY` or `ASANA_API_KEY` in `.env`, only for a ticket |
| `create-workspace` | Creates the run's branch in a worktree under `.worktrees/`. | the `workspace` block in the config |
| `baseline` | Runs the config's `baseline` command and saves the result, so later stages know what was already broken. | the `baseline` command in the config |
| `design` | Reads the code, asks you about the choices that change the shape of the build, writes a one-page `design.md` you approve. | you, at the terminal and in the browser |
| `planning` | Turns the design into phases, each change written as a diff with its test scenarios, in `plan.md`. You approve it. | you |
| `implement` | Builds each phase test-first and commits it. Independent phases run in parallel. | each package's commands in the config |
| `code-review` | Eight reviewer personas read the diff in parallel, then the fixes are applied and recorded. | nothing extra |
| `qa` | Drives the feature in a browser or a terminal, films the proof, and writes a proof report. A `FAIL` sends the bugs back to `implement`, up to 4 rounds. | `agent-browser`, `ffmpeg` |
| `git-commit` | Squashes the branch, then regroups the changes into conventional commits. Skipped when QA ended `BLOCKED` (it could not verify the change). | git |
| `visual-pr` | Pushes the branch and opens a pull request with a visual change outline and the proof. Skipped with `git-commit`. | `gh`, logged in |
| `retro` | Audits the run's transcripts and writes a ranked report of yok's own defects. Runs after a failed stage too. | nothing extra |

`ticket-fetcher` is optional in practice. With a plain prompt it changes nothing. Your own workflow can drop it and pass `{{ inputs.prompt }}` straight to `create-workspace`, as the example below does.

### quick: small tickets, fast execution

[workflows/quick.yaml](./workflows/quick.yaml) runs `ticket-fetcher → create-workspace → implement → code-review → git-commit → visual-pr`. There is no baseline, design, planning or QA stage, so it asks you nothing up front and films no proof of the change.

```bash
yok run quick --prompt "Rename the Customer.fullName getter to displayName"
```

Pick `quick` when you already know what the change is and could describe it to a colleague in two sentences: a rename, a copy change, a small bug with an obvious fix. Pick `task` when the change needs decisions, touches more than one part of the system, or must be verified in the running app.

### Write your own

Put a file in your project, check it, run it:

```yaml
# my-flow.yaml
name: my-flow
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: create-workspace
    type: agent
    stage: create-workspace
    input:
      request: "{{ inputs.prompt }}"
  - id: implement
    type: agent
    stage: implement
    dependsOn: [create-workspace]
    input:
      workspace: "{{ nodes.create-workspace.output }}"
      task: "{{ inputs.prompt }}"
  - id: review
    type: agent
    stage: code-review
    dependsOn: [implement]
    input:
      workspace: "{{ nodes.create-workspace.output }}"
```

```bash
yok verify ./my-flow.yaml                     # compile it and print the first error
yok doctor --workflow ./my-flow.yaml          # also run the checks it declares
yok run ./my-flow.yaml --prompt "…"
```

Every node has an `id`, an `input`, and optionally `dependsOn`, `when` (an expression that skips the node when false), `allowFailure` and `always`. The node types:

- `agent`: the agent runs a `stage` (a shipped or project skill) or a free `prompt`. `tier` picks the model.
- `exec`: runs a `script` with `runtime: sh` or `bun`, or calls `functionName` from a TypeScript `module`. `mode: background` lets it run alongside later nodes.
- `loop`: repeats its `nodes` `until` an expression is true, at most `maxIterations` times.
- `switch`: evaluates an `expression` and runs the `nodes` of the matching case, else `default`.
- `include`: runs another `workflow` file in place.
- `context`: gives the agent a fresh context, `action: new` or `action: compact`.
- `wait`: pauses for `durationMs`.

[demo-workflows/](./demo-workflows/) has a small workflow for each: `kitchen-sink.yaml` uses every node type, `step-demo.yaml` is all `exec` and `wait`, `context-demo.yaml` shows `context`, and `ticket-demo.yaml` adds a ticket provider of your own.

### Run without the notifier

To run with a project's Slack notifier turned off, pass a local config:

```bash
printf 'version: 2\nnotifier: { enabled: false }\n' > /tmp/yok-local.yaml
yok run task --prompt "…" --config /tmp/yok-local.yaml
```

## Commands

| Command | What it does |
|---|---|
| `yok run WORKFLOW --prompt TEXT` | Start a run. `--name`, `--input KEY=VALUE` (repeatable), `--config FILE`, `--no-attach`, `--no-open` |
| `yok attach [NAME]` | Attach to a run's agent terminal. `--run-id ID`, `--print` |
| `yok view [NAME]` | Open a run's page in the browser. `--run-id ID`, `--print` |
| `yok verify WORKFLOW` | Compile a workflow and print the first error |
| `yok doctor` | Check the tools, repository and config a run needs. `--json`, `--workflow NAME_OR_PATH` |
| `yok server start \| status \| stop` | Manage the local server. Stopping it leaves tmux sessions running |
| `yok update --agent NAME` | Install the newest release, move the plugin to it, restart the server. `--pre-release` |
| `yok plugin install --agent NAME` | Reinstall the plugin at the binary's version |
| `yok uninstall` | Remove yok from this machine. `--plugin`, `--no-plugin` |
| `yok types` | Write the SDK's type files to `.yok/types/` for your editor |
| `yok claude` / `yok codex` | Open an agent session by hand with the yok plugin loaded |
| `yok orchestrate …` | Called by skills during a run, not typed by hand |

## Skills

Each skill is a folder under `skills/`. In Claude Code every one is a slash command, `/yok:NAME`. In Codex it is `$NAME`. Both work inside any session, with or without a run. Click a name for its README.

| Skill | What it does |
|---|---|
| [design](./skills/design/README.md) | Reads the code, asks you the questions that shape the build, writes a one-page design you approve |
| [planning](./skills/planning/README.md) | Turns an approved design into phases, each change as a diff with its test scenarios |
| [implement](./skills/implement/README.md) | Builds a change, a plan or review feedback test-first and commits each phase |
| [tdd](./skills/tdd/README.md) | The RED-GREEN-REFACTOR cycle `implement` follows |
| [code-review](./skills/code-review/README.md) | Eight reviewer personas read a diff, then the fixes are applied and recorded |
| [refactor](./skills/refactor/README.md) | Assesses code for extraction, simplification and naming, then applies the changes |
| [code-quality](./skills/code-quality/README.md) | Strict types, immutability, pure functions, early returns; the rules every coding skill follows |
| [qa](./skills/qa/README.md) | Drives the feature, films the proof, writes the proof report |
| [git-commit](./skills/git-commit/README.md) | Groups a dirty tree into conventional commits with hunk-level staging |
| [visual-pr](./skills/visual-pr/README.md) | Creates or updates a PR with a visual change outline and validation evidence |
| [resolve-merge-conflict](./skills/resolve-merge-conflict/README.md) | Resolves a stopped merge or rebase, or a conflicting PR, by recovering each side's intent |
| [test-audit](./skills/test-audit/README.md) | Finds broken, flaky, slow and redundant tests, then proposes and applies a cleanup plan |
| [adr](./skills/adr/README.md) | Records one architecture decision in `docs/adr/` and adds it to the index |
| [retro](./skills/retro/README.md) | Audits a finished run's transcripts and writes a ranked report of yok defects |
| [ticket-fetcher](./skills/ticket-fetcher/README.md) | Fetches a Linear or Asana ticket into a bundle the other stages read |
| [create-workspace](./skills/create-workspace/README.md) | Creates the run's branch and worktree |
| [baseline](./skills/baseline/README.md) | Records the project's checks before any code changes |
| [writing-style](./skills/writing-style/README.md) | How every document a person reads is written: reports, PR bodies, READMEs |
| [orchestrate](./skills/orchestrate/README.md) | Drives a run from inside the agent session. The server starts it; you never type it |

## Uninstall

```bash
yok uninstall               # asks whether to remove the plugin from claude and codex too
yok uninstall --plugin      # remove the plugin without asking
yok uninstall --no-plugin   # keep the plugin without asking
```

This stops the yok server, deletes `~/.yok` (the binary, the run registry and the server log), and removes the `PATH` line the installer added to `~/.zshrc`, `~/.bashrc` or `~/.profile`. Run folders inside your projects stay, and so do running tmux sessions. Without a terminal to answer the question, the plugin stays. A Homebrew or npm install keeps its binary; finish with `brew uninstall yok` or `npm rm -g @vertexcover-io/yok`.

## Extending yok

A project can extend yok without forking it: replace one of a shipped skill's scripts, react to run events with its own subscribers, add a ticket provider, or add a stage of its own. These are TypeScript files in your project that import `@yok/sdk` and `zod`; the binary answers both imports itself, so you install neither. For your editor, run `yok types` and add the path mapping it prints to `tsconfig.json`. [How to change it](./docs/guide/08-how-to-change-it.md) has one recipe per kind of change.

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
