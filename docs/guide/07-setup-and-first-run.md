# Setup and first run

This page gets Yok running from source on your laptop and takes you through your first run. Budget thirty minutes. Every command is exact. "You know it worked when" lines tell you what to expect.

You are setting up the **dev build**, `yok-dev`, which runs the TypeScript in this checkout directly. It lives beside the release `yok` and never replaces it. Edits show on the next run with no build step, and each `yok-dev run` or `yok-dev view` restarts the server so it runs them too.

## 1. Install the tools

macOS or Linux. Install what is missing:

| Tool | Version | Install | Why |
|---|---|---|---|
| Bun | 1.3.3 or newer | `curl -fsSL https://bun.sh/install \| bash` | runs the source and the tests |
| Node | 22.12 or newer | `brew install node` | a few repo scripts use `node --test` |
| tmux | 3.3 or newer | `brew install tmux` | every agent session lives in a tmux window |
| git | any recent | `brew install git` | |
| jq, curl | any | `brew install jq curl` | skills use them in shell steps |
| Claude Code | current | see claude.com/claude-code | the agent |
| GitHub CLI | any, logged in | `brew install gh && gh auth login` | the pr stage |
| ffmpeg, agent-browser | any | `brew install ffmpeg`, `npm i -g agent-browser && agent-browser install` | the qa stage films proof |

Codex works too. Install it with `npm i -g @openai/codex`. The rest of this page says Claude.

## 2. Get the code

```bash
git clone https://github.com/vertexcover-io/yok.git
cd yok
bun install
```

Development happens on `main`.

You know it worked when `bun install` ends without errors and `ls node_modules/@yok` lists `cli core sdk server`.

## 3. Put `yok-dev` on your PATH

```bash
cd packages/cli && bun link && cd ../..
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc
exec zsh
yok-dev --version
```

You know it worked when `yok-dev --version` prints a version and `which yok-dev` points into `~/.bun/bin`.

## 4. Check the machine

Run the doctor inside this repo:

```bash
yok-dev doctor
```

It prints one row per check marked `OK`, `WARN`, or `FAIL`, with the first fix step beside each, and a verdict line at the end. Fix every `FAIL`. The common ones:

- **tmux older than 3.3.** `brew upgrade tmux`.
- **gh: not logged in.** `gh auth login`. It is optional for the demo workflows and required for the real one.

You know it worked when the verdict line is `READY`, or `DEGRADED` with only warnings you understand. `BLOCKED` means a run would refuse to start.

## 5. Run the checks

```bash
bun run check
```

This runs typecheck, lint, and the whole test suite and prints one JSON summary. It takes a couple of minutes.

You know it worked when the JSON shows `"errors": 0` for typecheck and lint and `"failed": 0` for tests.

## 6. Your first run: a workflow with no agent work

Start with `step-demo`. It has only exec and wait nodes, so the agent only drives the loop and nothing needs a ticket, a Slack token, or a worktree. It finishes in under a minute.

One more check runs at `yok run` time that the doctor alone does not: the notifier. The server runs it, with the rest of the doctor, when the run starts. This repo's config turns the Slack notifier on, so a run blocks unless `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` are in a `.env` file at the repo root. If you do not have them, make a local config that turns it off. This file is yours and is not committed:

```bash
cat > /tmp/yok-local.yaml <<'EOF'
version: 2
notifier: { enabled: false }
EOF
```

Then:

```bash
yok-dev run demo-workflows/step-demo.yaml --prompt "hello" --config /tmp/yok-local.yaml
```

Drop `--config …` if you have the Slack variables in `.env`.

What you will see, in order:

1. The CLI starts the server and adds this checkout as a project, named after its folder. The server compiles the workflow and runs the doctor. The first time, that takes a few seconds.
2. It prints a run id like `r-1a2b3c4d`, an attach command, and a `view:` URL, and opens the URL in your browser.
3. Your terminal becomes the agent's tmux window. `yok run` attaches by default; `--no-attach` skips it. You watch Claude read the orchestrate skill, run `yok orchestrate init`, then `next`, `exec`, `next`, `exec`, and so on.
4. Claude says the run finished with `completed`.

Detach with `Ctrl-b d`. The session keeps running without you. Reattach any time:

```bash
yok-dev attach --run-id r-1a2b3c4d
```

A reboot or an agent crash ends the session but not the run. Bring it back where it stopped,
on the model and in the conversation it had:

```bash
yok-dev resume step-demo
```

You know it worked when `cat .yok/step-demo/state.json | jq .status` prints `"completed"` and `.yok/step-demo/event.jsonl` has a few dozen lines.

Read that `event.jsonl` once, top to bottom. It is the best ten minutes you will spend on this codebase.

## 7. Second run: every node type

```bash
yok-dev run demo-workflows/kitchen-sink.yaml --prompt "pick any topic" --config /tmp/yok-local.yaml
```

This one uses agent nodes with demo stages, a loop that fails its first pass on purpose, a switch, a skipped branch, and an included workflow. The comment at the top of the YAML says what each node should do. Watch it in the viewer. When it ends, compare `state.json`'s `nodeRuns` against that comment.

## 8. The real thing

```bash
yok-dev run task --prompt "Describe a small change to this repo"
```

This needs `LINEAR_API_KEY` in `.env` (the workflow's doctor block asks for it even for a plain prompt), `gh` logged in, and about an hour. The design and planning stages will ask you questions in the agent's terminal and show you pages in the viewer to approve. Follow [One task, end to end](05-one-task-end-to-end.md) while it runs.

## 9. Run yok on a server

To start runs on another machine, run the release `yok` there as a systemd user service, with Caddy in front of it. The yok server listens only on `127.0.0.1` and has no login of its own. Caddy does https and the login, then forwards each request to yok. On the server itself, nothing asks for a login.

On the server, as the user who will own the runs:

1. Install yok, tmux, git, claude (or codex) and Caddy. Log in to claude once: every run uses that login.
2. Set the public domain in `~/.yok/.env`, so dashboard links point at Caddy and yok accepts the requests Caddy forwards:

   ```sh
   SERVER_DOMAIN=yok.example.com
   ```

   yok lowercases the value and drops a scheme and trailing slashes. It reads the file once, when the server starts, so after changing `SERVER_DOMAIN` run `yok server stop`; the next command starts the server again.

3. Write `~/.config/systemd/user/yok.service`:

   ```ini
   [Unit]
   Description=yok server
   After=network-online.target

   [Service]
   ExecStart=%h/.yok/bin/yok server start --port 7777
   Restart=on-failure
   Environment=PATH=%h/.yok/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin

   [Install]
   WantedBy=default.target
   ```

   The `PATH` line matters because a service does not load your shell profile. Without it, yok cannot find claude, tmux or git. `--port 7777` pins the port the Caddyfile points at.

4. Start it, and keep it running when nobody is logged in:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now yok
   sudo loginctl enable-linger "$USER"   # keep it running with nobody logged in
   journalctl --user -u yok -f           # follow the log
   ```

5. Print a password hash with `caddy hash-password`, then write `/etc/caddy/Caddyfile`. The domain on its first line must match `SERVER_DOMAIN`:

   ```caddyfile
   yok.example.com {
       basic_auth {
           ritesh HASH_FROM_CADDY_HASH_PASSWORD
       }
       reverse_proxy 127.0.0.1:7777
   }
   ```

   ```sh
   sudo systemctl enable --now caddy
   ```

   Caddy gets and renews the https certificate itself. That needs the domain pointing at the server's public IP, and ports 80 and 443 open. A machine without those can use Tailscale Serve instead.

On your laptop:

```bash
yok remote login https://yok.example.com --user ritesh   # asks for the password, hidden
yok remote project add web --git git@github.com:acme/web.git
yok remote run task --prompt "fix login" --project web
yok remote status
```

`login` asks for the password without echoing it. A script can pipe it on stdin or set `YOK_SERVER_PASSWORD`; `--password` stays for CI, but shows in the process list. It sends one request with the login. It saves `YOK_SERVER_URL`, `YOK_SERVER_USER` and `YOK_SERVER_PASSWORD` to `~/.yok/.env` only when the server accepts it. When the shell sets `YOK_SERVER_URL`, all three are read from the shell and the file is ignored; otherwise all three come from the file. So a CI job sets all three and needs no login, and a shell password is never sent to the saved server. `yok-dev remote …` does the same from this checkout, with `~/.yok-dev/.env`. `yok-remote` is a shortcut for `yok remote`.

Every remote command checks the server first. If the versions differ, it prints `warning: this CLI is A, the server is B` and carries on. To fix that, run `yok update` on the laptop, or upgrade yok on the server and run `systemctl --user restart yok`.

A remote run prints its id and dashboard link, and does not attach. Nobody sits at its terminal, so it runs with `interaction: false` unless you pass `--interaction true`. To answer its questions anyway, SSH into the server and attach to the run there.

You know it worked when `yok remote status` prints the server's version and pid, and the `view:` link from `yok remote run` opens the dashboard after the browser's login box. If every request through Caddy gets a 403, `SERVER_DOMAIN` does not match the domain Caddy serves.

## Useful commands

```bash
yok-dev server status           # is the server up, pid, version
yok-dev server stop             # stop it; tmux sessions keep running
yok-dev project list            # the checkouts the server runs on, and their status
yok-dev project add [NAME]      # add this checkout, or --path DIR, or --git URL to clone
yok-dev project remove NAME     # forget one; --purge also deletes a folder yok cloned
yok-dev remote login URL --user U  # asks for the password; save a server's login; checks it first
yok-dev remote status           # the server's version, pid and start time
yok-dev remote run task --prompt "…" --project NAME  # start a run there, unattended
yok-dev remote project list     # the server's projects; also doctor, trigger
tail -f ~/.yok-dev/server.log   # what the server is doing
yok-dev view --run-id r-…       # reopen a run's page
tmux ls                         # every agent session on the machine
yok-dev verify path/to.yaml     # compile a workflow, print the first error
yok-dev trigger list            # every cron trigger, its next and last fire
yok-dev trigger log NAME        # a trigger's last 20 firings, with run ids
LOG_LEVEL=debug yok-dev run …   # stacks and debug lines on stderr
```

## When it breaks

**"yok server did not start within 5s."** Read the tail it prints, or `~/.yok-dev/server.log`. A port another program took is not the cause: the server falls back to a free port and rewrites `server.port`. The usual cause is a missing tmux.

**The doctor says `.yok/` is not gitignored.** Add `.yok/*` to `.gitignore`. This repo already has it.

**BLOCKED on LINEAR_API_KEY.** You ran `task` without a Linear key. Add it to `.env`, or run a demo workflow. The doctor reads a key missing from `.env` from the server's environment, not your shell's, so on a remote server the key belongs in the project's `.env`.

**Two servers, two registries.** `yok` (release) and `yok-dev` (source) keep separate homes, `~/.yok` and `~/.yok-dev`. A run started by one is invisible to the other. Pick one for the day.

**The agent stopped and nothing happens.** Attach and read the screen. If it is asking a question, answer it. If it ended its turn, the Stop hook should have sent it back; look for `hooks.stop.called` at the end of `event.jsonl` and read its `reason`.

**`bun run lint` finds no files inside `.worktrees/`.** `biome.json` excludes that path. Lint from the main checkout, or use a temporary Biome config without the exclusion.

**Claude says the plugin version does not match.** That is a release-build message. With `yok-dev`, the checkout is the plugin, so you should not see it. If you do, you ran `yok` instead of `yok-dev`.

## The dev loop

Edit TypeScript, run again. `yok-dev` runs the source, so there is nothing to build. The agent sessions it starts call `yok-dev` back whenever a skill says `yok`.

```bash
bun test packages/core                      # one package's tests
bun test packages/core/src/workflow/next.test.ts
bun run typecheck
bun run lint
bun run check                               # all three, before a PR
```

Tests sit beside the code they test. `*.test.ts` are unit tests. `*.e2e.test.ts` drive the real commands against a temporary repo and a temporary yok home, and take longer.

Next: [How to change it](08-how-to-change-it.md).
