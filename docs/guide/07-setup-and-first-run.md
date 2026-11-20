# Setup and first run

This page gets Yok running from source on your laptop and takes you through your first run. Budget thirty minutes. Every command is exact. "You know it worked when" lines tell you what to expect.

You are setting up the **dev build**, `yok-dev`, which runs the TypeScript in this checkout directly. It lives beside the release `yok` and never replaces it. Edits show on the next run with no build step, and each `yok-dev run` or `yok-dev view` restarts the server so it runs them too.

## 1. Install the tools

macOS or Linux. Install what is missing:

| Tool | Version | Install | Why |
|---|---|---|---|
| Bun | 1.4.3 or newer | `curl -fsSL https://bun.sh/install \| bash` | runs the source and the tests |
| Node | 22.12 or newer | `brew install node` | a few repo scripts use `node --test` |
| tmux | 3.3 or newer | `brew install tmux` | every agent session lives in a tmux window |
| git | any recent | `brew install git` | |
| jq, curl | any | `brew install jq curl` | skills use them in shell steps |
| Claude Code | current | see claude.com/claude-code | the agent |
| GitHub CLI | any, logged in | `brew install gh && gh auth login` | the pr stage |
| ffmpeg, agent-browser | any | `brew install ffmpeg`, `npm i -g agent-browser && agent-browser install` | the qa stage films proof |
| agent-device | any, optional | `npm i -g agent-device@latest && agent-device doctor` | the qa stage drives iOS and Android apps |

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

A run that failed, on a test that would not pass or a stage that gave up, can pick up at the step
that failed instead of starting over. Every step that finished stays finished; the failed one runs
again in a new agent session, which reads the run's artifacts in `.yok/step-demo/artifacts`:

```bash
yok-dev retry step-demo
```

When the step failed waiting on a person's answer (every agent step's error is recorded that way
when the run's `interaction` policy is off), deal with what it asked first, then pass `--answered`.

You know it worked when `yok-dev orchestrate get status --run step-demo` prints `"completed"` and `yok-dev orchestrate events --run step-demo` prints a few dozen events.

Read those events once, top to bottom. It is the best ten minutes you will spend on this codebase.

## 7. Second run: every node type

```bash
yok-dev run demo-workflows/kitchen-sink.yaml --prompt "pick any topic" --config /tmp/yok-local.yaml
```

This one uses agent nodes with demo stages, a loop that fails its first pass on purpose, a switch, a skipped branch, and an included workflow. The comment at the top of the YAML says what each node should do. Watch it in the viewer. When it ends, compare what `yok-dev orchestrate get nodeRuns --run NAME` prints, NAME being the name the run took, against that comment.

## 8. The real thing

```bash
yok-dev run task --prompt "Describe a small change to this repo"
```

This takes about an hour. The doctor runs first and names anything the run is missing, with its fix, such as `gh` not logged in. The design and planning stages will ask you questions in the agent's terminal and show you pages in the viewer to approve. Follow [One task, end to end](05-one-task-end-to-end.md) while it runs.

## 9. Run yok on a server

To start runs on another machine, run the release `yok` there as a systemd user service, with Caddy in front of it. The yok server listens only on `127.0.0.1`. Caddy does https and nothing else: yok itself checks who is calling, per person, through GitHub sign-in ([ADR 0045](../adr/0045-yok-checks-the-caller-on-every-route-of-a-gated-server.md)).

**To share a server, set `SERVER_DOMAIN`. A server without it is open.** With no `SERVER_DOMAIN`, yok is local: `yok run`, the local browser and every command on the machine work with no login, exactly as on your laptop. With it, the server is gated, and every route needs a signed-in caller: a browser with yok's session cookie, or a CLI token sent as `Authorization: Bearer`. The routes left open are `/api/health`, `/login`, the GitHub sign-in routes, the device-login routes the CLI uses, and `/api/hooks/slack`, whose gate is Slack's signature.

On the server, as the user who will own the runs:

1. Install yok, tmux, git, claude (or codex) and Caddy. Log in to claude once: every run uses that login.
2. Register a GitHub OAuth app (Settings > Developer settings > OAuth Apps) with the callback URL `https://yok.example.com/auth/github/callback`. Then write `~/.yok/.env`:

   ```sh
   SERVER_DOMAIN=yok.example.com
   GITHUB_CLIENT_ID=…
   GITHUB_CLIENT_SECRET=…
   SUPER_ADMIN_LOGINS=your-github-login
   GITHUB_ORGS=acme
   ```

   `SERVER_DOMAIN` makes dashboard links point at Caddy, lets yok accept the requests Caddy forwards, and turns the gate on. yok lowercases the value and drops a scheme and trailing slashes. It reads the file once, when the server starts, so after changing `SERVER_DOMAIN` run `yok server stop`; the next command starts the server again.

   Who may sign in is decided only when someone signs in with GitHub ([ADR 0046](../adr/0046-sign-in-is-decided-by-github-org-or-a-super-admin-login.md)). `SUPER_ADMIN_LOGINS` lists GitHub logins that get in with no org. `GITHUB_ORGS` lists org slugs, and a member of any of them gets in. Both are comma-separated, compared without regard to case, and read on each sign-in, so a change needs no restart. A gated server with neither still starts and logs a warning; its `/login` page says which key is missing. The sign-in asks GitHub for the `read:org` scope so private org memberships show; this comes from GitHub's documentation and was not tested against GitHub. Someone who is refused sees a 403 page, and yok revokes the GitHub token it was just given and creates no user. Removing someone from the org, or from `SUPER_ADMIN_LOGINS`, takes effect at their next sign-in: yok has no way to cut a person off before that. When the refused account already has a yok user, that user is marked as revoked and their CLI tokens are deleted; a later successful sign-in clears the mark. A revoked user is refused by cookie, by token and in Slack.

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

5. Write `/etc/caddy/Caddyfile`. The domain on its first line must match `SERVER_DOMAIN`. There is no `basic_auth` and no exemption for Slack:

   ```caddyfile
   yok.example.com {
       reverse_proxy 127.0.0.1:7777
   }
   ```

   ```sh
   sudo systemctl enable --now caddy
   ```

   Caddy gets and renews the https certificate itself. That needs the domain pointing at the server's public IP, and ports 80 and 443 open. A machine without those can use Tailscale Serve instead.

On your laptop:

```bash
yok login --server https://yok.example.com
yok-remote project add web --git git@github.com:acme/web.git
yok-remote run task --prompt "fix login" --project web
yok-remote server status
```

`yok-remote` is `yok --remote`: the same commands, aimed at the saved server instead of this machine. The flag may go anywhere on the line. The saved login is read only with that flag, so a plain `yok run` never leaves your laptop. `run`, `project`, `trigger`, `doctor`, `login`, `ls`, `resume`, `retry` and `server status` take the flag; `--project` is required with it, because the folder you are in means nothing on the server. `ls` takes `--project` only as a filter, and `resume` and `retry` need it only with a run name, not with `--run-id`. Anything else refuses it with one line, such as `yok attach works only on this machine: run it as yok attach, without --remote`, and `login` and `logout` need no `--remote`: they always talk to the server you name.

`yok login --server URL` works like `gh auth login`. It posts this machine's name to the server, prints a page address and a short code such as `ABCD-EFGH`, and opens the page when it can. On the page, sign in with GitHub if you are not, check the code, and press Approve ("Give the yok CLI on MACHINE access as YOU?"). The CLI polls until you do; the request lives for 10 minutes. It then receives a token once, checks it against `GET /api/me`, and saves `YOK_SERVER_URL` and `YOK_SERVER_TOKEN` to `~/.yok/.env` with mode 0600, removing the old `YOK_SERVER_USER` and `YOK_SERVER_PASSWORD` lines. A failed login never replaces a working one. The server keeps only the token's SHA-256, and the token never expires: it ends when you revoke it. `yok logout` revokes this machine's token on the server and removes `YOK_SERVER_TOKEN` from the file.

Open `/settings` on the server in a browser to see each token with its last use, revoke one, or create one for a script or CI, which is shown once. When the shell sets `YOK_SERVER_URL`, both it and `YOK_SERVER_TOKEN` are read from the shell and the file is ignored; otherwise both come from the file. So a CI job sets both and needs no login, and a shell token is never sent to the saved server. `yok-dev --remote …` does the same from this checkout, with `~/.yok-dev/.env`.

A plain command on the server's own machine, such as `yok ls`, sends no token. On a gated server it gets a 401 and tells you to run `yok login --server URL` and then use `--remote`. A `--remote` command whose saved login is an old password says to run `yok login --server URL`.

Every `--remote` command checks the server first. If the versions differ, it prints `warning: this CLI is A, the server is B` and carries on. To fix that, run `yok update` on the laptop, or upgrade yok on the server and run `systemctl --user restart yok`.

A remote run prints its id and dashboard link, and does not attach. Nobody sits at its terminal, so it runs with `interaction: false` unless you pass `--interaction true`. While its agent runs, answer it from the run's page: the Terminal tab attaches to the run's tmux session in the browser, as `yok attach` does on the server.

With `interaction: false`, a step that needs an answer fails the run instead of waiting. Deal with what it asked, then click Retry on the run's page and choose Retry as answered, or run:

```bash
yok-remote retry fix-login --project web --answered
```

When the agent stopped on a run that did not fail, after a reboot or a crash, Resume on the page, or `yok-remote resume fix-login --project web`, starts it again where it stopped. Either command takes `--run-id ID` instead of a name and `--project`, and prints the run's id and link as `yok-remote run` does. The server checks the run as it checks a new one, so a resume the doctor blocks names the failing checks and their fixes.

The terminal is a websocket at `/api/runs/RUN_ID/terminal`, behind the same caller check and the same Host and Origin check as the rest of the page: a request with no signed-in caller is answered 401 before the upgrade. Caddy's `reverse_proxy` passes websockets through by default, so the Caddyfile above needs no change; the page uses `wss://` when it is served over https. Ctrl-\ detaches, and the page offers Reattach.

On Linux and Windows the browser keeps Ctrl-W and Ctrl-T for itself: they close or open a tab instead of reaching the agent. Install the page as an app (Chrome's "Install page as app") to get them back. On macOS those keys reach the agent, and Cmd-W closes the window either way.

You know it worked when `yok-remote server status` prints the server's version and pid, and the `view:` link from `yok-remote run` opens the dashboard after you sign in with GitHub. If every request through Caddy gets a 403, `SERVER_DOMAIN` does not match the domain Caddy serves.

### Move a server from the shared password

A server set up before the sign-in gate had one Caddy password for everybody. No release accepts both, so move in this order:

1. On the server, upgrade yok (`yok update`), add `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SUPER_ADMIN_LOGINS` and `GITHUB_ORGS` to `~/.yok/.env` as above, and run `yok server stop`. If people already sign in with GitHub for Slack, the OAuth app exists and is reused; its sign-in now also asks for `read:org`.
2. In the Caddyfile, remove the `basic_auth` block and the `handle /api/hooks/slack` exemption, leaving the domain and `reverse_proxy`, then `sudo systemctl reload caddy`.
3. Each person runs `yok login --server https://yok.example.com` once. Until they do, `--remote` commands say the saved login was a password and name that command.
4. In each repo that uses the GitHub Action, delete the `YOK_USER` and `YOK_PASSWORD` secrets and add `YOK_TOKEN` (below).
5. In Slack, each person types `@yok login` once; commands from anyone not linked get one private reply that says so.

### Drive yok from Slack

1. Create a Slack app in your workspace. Under Event Subscriptions, turn events on, set the request URL to `https://yok.example.com/api/hooks/slack`, and subscribe to the `app_mentions:read` bot event (`app_mention`). Add the `chat:write` bot scope and install the app.
2. Create a private channel, invite the people allowed to drive yok and the app, and copy the channel's id (channel details, at the bottom).
3. Add three lines to the server's `~/.yok/.env`; the server reads them on every request, so no restart is needed:

   ```sh
   SLACK_SIGNING_SECRET=…   # the app's Basic Information page
   SLACK_BOT_TOKEN=xoxb-…   # the app's OAuth & Permissions page
   SLACK_COMMAND_CHANNEL=C0123456789
   ```

4. Type `@yok help` in the channel. Only messages in that channel are answered.

On a server with `SERVER_DOMAIN`, a command also needs the person to be linked to a yok user who still has access. Anyone else gets one reply only they can see, telling them to type `@yok login`. `login`, `whoami` and `help` are open to everyone in the channel. A run or project started from Slack records the linked user.

A command is typed as on the command line, quotes included: `@yok run task --project web --prompt "fix login"`. Curly quotes, which Slack often types for you, work the same. A prompt without `--prompt` is refused. `--input KEY=VALUE` and the policy flags work as with `yok run`, except that `interaction` stays off whatever you pass: nobody sits at a Slack-started run's terminal to answer it.

A run started from Slack posts its updates in the thread under the message, in whichever channel the message was typed, whenever the project's Slack notifier is on. The channel in the project's `.env` (`SLACK_CHANNEL_ID`) is used by runs started elsewhere.

### Start runs from pull request comments

1. Register the repo on the server: `yok --remote project add web --git git@github.com:ORG/web.git`.
2. Copy [.github/workflows/yok.yml](../../.github/workflows/yok.yml) from this repo to the same path in the repo, on its default branch. The yok repo runs the same file on its own pull requests.
3. Under the repo's Settings > Secrets and variables > Actions, add the variables `YOK_SERVER_URL` and `YOK_PROJECT` (`web`) and the secret `YOK_TOKEN`: sign in to the server, open `/settings`, create a token named for the repo, and copy it at once, since the server shows it only once. The job sends it as `Authorization: Bearer` straight to the server's API, since it has no browser. Revoke the token in `/settings` to cut the job off.

Comment `/yok fix the review comments` on a pull request. The comment can be in the conversation, in a review thread, where the prompt carries the comment's link so `/yok fix this` works, or in a review's summary. A review starts one run for its summary and one for each line comment that starts with `/yok`, so put `/yok` in one place. The job replies where `/yok` was typed, in the review thread or on the conversation, with a link to the run's page, posted as github-actions[bot]; its log prints the same link. Only people with write access to the repo start runs, with `interaction` off; the job checks the commenter's permission with GitHub. The run pushes and replies with the server's own `gh` login.

`/yok --workflow NAME …` starts any workflow that takes a prompt, such as `/yok --workflow quick fix the failing test`. `/yok` matches in any case, and a prompt wrapped whole in quotes, such as `/yok "fix CI"`, loses the quotes. The prompt the Action sends ends with a `Pull request: URL` line, so the workflow's workspace starts from the pull request's own branch, its commits land there with no force push, and it replies on the pull request instead of opening another.

## Useful commands

```bash
yok-dev server status           # is the server up, pid, version
yok-dev server stop             # stop it; tmux sessions keep running
yok-dev project list            # the checkouts the server runs on, and their status
yok-dev project add [NAME]      # add this checkout, or --path DIR, or --git URL to clone
yok-dev project rm NAME         # forget one; --force deletes its runs and a folder yok cloned
yok-dev login --server URL      # sign in to a shared server in the browser; saves YOK_SERVER_TOKEN
yok-dev logout                  # revoke this machine's token and remove it from the file
yok-dev --remote server status  # the server's version, pid and start time
yok-dev --remote run task --prompt "…" --project NAME  # start a run there, unattended
yok-dev --remote retry NAME --project P --answered  # bring a failed run back there
yok-dev --remote project list   # the server's projects; also doctor, trigger
tail -f ~/.yok-dev/server.log   # what the server is doing
yok-dev view --run-id r-…       # reopen a run's page
yok-dev rm NAME                 # delete a finished run's record and .yok folder; frees its name
tmux ls                         # every agent session on the machine
yok-dev verify path/to.yaml     # compile a workflow, print the first error
yok-dev trigger list            # every cron trigger, its next and last fire
yok-dev trigger log NAME        # a trigger's last 20 firings, with run ids
LOG_LEVEL=debug yok-dev run …   # stacks and debug lines on stderr
```

## When it breaks

**"yok server did not start within 5s."** Read the tail it prints, or `~/.yok-dev/server.log`. A port another program took is not the cause: the server falls back to a free port and rewrites `server.port`. The usual cause is a missing tmux.

**`/login` says "No one can sign in yet".** The server has `SERVER_DOMAIN` but neither `SUPER_ADMIN_LOGINS` nor `GITHUB_ORGS`. Set one in the server's `~/.yok/.env`; no restart is needed. If it says GitHub sign-in is not set up, `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is missing.

**A `--remote` command says "run yok login".** The server answered 401: there is no token, it was revoked, or the person's access ended. Run `yok login --server URL`.

**The doctor says `.yok/` is not gitignored.** Add `.yok/*` to `.gitignore`. This repo already has it.

**The ticket-fetcher stage stops on a missing API key.** Your prompt names a ticket and the key for its platform is not set: `LINEAR_API_KEY` for Linear, `ASANA_API_KEY` for Asana, or the key a project-added provider names. Add it to `.env`, or describe the task in a plain prompt. The stage reads the key from the project's `.env`, then the environment, so on a remote server the key belongs in the project's `.env`.

**Two servers, two databases.** `yok` (release) and `yok-dev` (source) keep separate homes, `~/.yok` and `~/.yok-dev`, each with its own `yok.db`. A run started by one is invisible to the other. Pick one for the day.

**The agent stopped and nothing happens.** Attach and read the screen. If it is asking a question, answer it. If it ended its turn, the Stop hook should have sent it back; look for `hooks.stop.called` at the end of `yok orchestrate events --run NAME` and read its `reason`.

**Runs from before an update are missing.** A yok from before `yok.db` kept its records in files: `registry.json`, `users.json`, `projects.yaml`, `triggers.json` in the home, and `state.json`, `event.jsonl`, `comments.json` in each run folder. Run `yok import-files` once, with no run going. It copies them into `yok.db`, skips a run whose folder is gone, and renames each file it read with `.imported`; `users.json.imported` keeps no GitHub token, since `yok.db` now holds them. Running it again after a failure is safe: it skips what it already stored.

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
