# Deploying the yok server

One Linux box runs the yok server behind a proxy that does https and the login. The `Deploy`
workflow puts a release on it. It runs by hand only (Actions, Deploy, Run workflow): with a tag,
that release; with the tag left empty, the latest release. The same run also sets the box up the
first time, so there is no separate install step.

By default the proxy is Caddy, which the deploy installs and configures. A box that already has
its own proxy, such as a hosting provider's edge or a web panel's nginx, keeps it: set the
`PROXY` secret to `own` and the deploy leaves ports 80 and 443 alone. See *Your own proxy*.

```
laptop ── https + login ──► Caddy :443 ──► yok server 127.0.0.1:7777 (systemd user unit)
                                               └── runs in tmux sessions, agents read the tokens
```

## What you do once

1. A server running Debian or Ubuntu, with an ssh user that has passwordless sudo, and the
   Caddy apt repository configured so `apt-get install caddy` works (not needed with your own
   proxy).
2. A DNS record for your domain pointing at it, with ports 80 and 443 open. Caddy gets and
   renews the certificate itself. With your own proxy, whatever that proxy needs instead.
3. The repository secrets below.

## Secrets

Under Settings, Secrets and variables, Actions. The workflow stops before touching the server
and names any required one that is missing.

| Secret | Required | What it is |
|---|---|---|
| `DEPLOY_HOST` | yes | the server's address |
| `DEPLOY_USER` | yes | the ssh user; it owns the yok home and the runs |
| `DEPLOY_SSH_KEY` | yes | a private key whose public half is in that user's `authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | yes | the output of `ssh-keyscan HOST`, so the workflow trusts only that server |
| `SERVER_DOMAIN` | yes | the domain Caddy serves, such as `yok.example.com` |
| `YOK_USER` | yes | the login name for the dashboard and `yok-remote` |
| `YOK_PASSWORD` | yes | its password; the server stores a hash of it, never the password. With your own proxy, whatever that proxy accepts as the Basic auth password |
| `PROXY` | no | `caddy` (default) or `own`: skip installing and configuring Caddy |
| `YOK_BIND` | with `PROXY=own` | the address yok listens on so the proxy can reach it; yok has no login of its own, so this must be an address only the proxy reaches |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of the two | from `claude setup-token` on your laptop; lasts a year |
| `CODEX_API_KEY` | one of the two | an OpenAI API key; stored on the server by `codex login` |
| `GH_TOKEN` | only if the repo is private | a token that can read the repository's contents |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | for Slack messages | the notifier's bot token and channel; a run whose config turns the notifier on stops without them |
| `SLACK_MEMBER_ID` | no | the person the notifier mentions when a run needs someone |

## What a deploy does

`deploy.sh` runs on the server as the ssh user, in this order, and each step is safe to repeat:

1. **packages**: installs git, tmux, jq, curl, gh, ripgrep, ffmpeg, node and Caddy with apt, and
   claude, codex, agent-browser and ast-grep with npm, skipping what is present.
2. **config**: writes `SERVER_DOMAIN` and `YOK_BIND` to `~/.yok/.env`, the tokens and Slack
   keys to `~/.yok/secrets.env` (mode 600), and the domain, user and password hash to `/etc/caddy/.env`.
3. **caddy**: installs the Caddyfile and the drop-in that points Caddy at its env file, then
   validates and reloads. With `PROXY=own`, steps 1 to 3 leave Caddy out entirely.
4. **yok**: installs the tag with `install.sh`, which also moves the agent plugin and writes the
   `yok-remote` shortcut, then logs Codex in when it has a key.
   Then marks Claude's first-run onboarding as done, so a run's session goes straight to its
   prompt instead of waiting on the theme menu.
5. **service**: installs the user unit, enables linger so it survives logout, restarts it, and
   drops an idle tmux server so the next run's session sees today's tokens.
6. **check**: waits for `/api/health` on loopback to answer with the tag's version.

The workflow then asks `https://SERVER_DOMAIN/api/health` with the login, the request a laptop
makes, and fails unless the version matches.

## Your own proxy

With `PROXY=own`, nothing on the box does https or asks for a login; the proxy already in front
of it must. yok's CLI sends HTTP Basic auth on every request and treats a 401 as a wrong login,
so the proxy has to:

- terminate https for `SERVER_DOMAIN` and forward to yok on `YOK_BIND:7777` with the `Host`
  header unchanged, or yok's Host guard answers 403;
- require Basic auth, with `YOK_USER` and `YOK_PASSWORD` as a pair it accepts, since the
  workflow's final check and every laptop send exactly those;
- keep idle connections open: the dashboard holds long-lived event streams.

yok then listens on `YOK_BIND` instead of loopback, because a proxy elsewhere on the network
cannot reach 127.0.0.1. yok itself asks nobody for a login, so whatever can reach that address
can start runs: `YOK_BIND` must be an address only the proxy reaches, such as a private
interface, and `0.0.0.0` is right only on a box whose public side is the proxy, with no public
address of its own. On any box with a public address, use the private interface or a firewall
rule that admits port 7777 from the proxy alone.

### Example: an exe.dev VM

exe.dev's edge terminates TLS, forwards `https://VM.exe.xyz/` to the VM's shared port, and
gates it behind its own login: a browser is sent to exe.dev to sign in, and a script sends a
VM token as the Basic auth password with any username. That maps onto the secrets directly.

```
browser ──► https://VM.exe.xyz ──► exe.dev login (once) ──┐
yok-remote ──► same URL + Basic anyone:<VM token> ────────┼──► exe.dev edge ──► yok 0.0.0.0:7777
```

1. `ssh exe.dev new --name=VM`, then `ssh exe.dev share port VM 7777`. Leave the VM private;
   `ssh exe.dev share add VM someone@example.com` for each dashboard user.
2. `ssh exe.dev ssh-key generate-api-key --vm=VM --label=deploy` prints the token.
3. Secrets: `PROXY=own`, `YOK_BIND=0.0.0.0` (the VM has only private addresses; its public
   side is exe.dev's edge), `SERVER_DOMAIN=VM.exe.xyz`, `YOK_PASSWORD=<the token>`,
   `YOK_USER` anything, `DEPLOY_HOST=VM.exe.xyz`, `DEPLOY_USER=exedev`. The deploy key goes in
   with `ssh exe.dev ssh-key add --vm=VM --ssh-user=exedev`, not into `authorized_keys`.
4. On a laptop: `YOK_SERVER_PASSWORD=<the token> yok-remote login https://VM.exe.xyz --user me`.

Each person mints their own token the same way, so leaving the team means removing one key.

## Rotating a secret

Change it in GitHub and run the workflow by hand with the current tag. Runs in progress keep
their old tokens; the next run picks up the new ones.

## When it fails

- The check steps print the version the server answered, or nothing. On the box,
  `journalctl --user -u yok -f` is the server log and `sudo journalctl -u caddy -f` is Caddy's.
- A 403 on every request through the proxy means `SERVER_DOMAIN` differs from the `Host` the
  proxy forwards. With Caddy both come from the same secret, so this points at a stale deploy;
  with your own proxy, check that it passes `Host` through unchanged, port included.
- A deploy that failed before the service step left the previous version running.
