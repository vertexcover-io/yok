# Deploying the yok server

One Linux box runs the yok server behind Caddy. The `Deploy` workflow puts a release on it: it
fires when a release is published, and by hand with a tag (Actions, Deploy, Run workflow). The
same run also sets the box up the first time, so there is no separate install step.

```
laptop ── https + login ──► Caddy :443 ──► yok server 127.0.0.1:7777 (systemd user unit)
                                               └── runs in tmux sessions, agents read the tokens
```

## What you do once

1. A server running Debian or Ubuntu, with an ssh user that has passwordless sudo, and the
   Caddy apt repository configured so `apt-get install caddy` works.
2. A DNS record for your domain pointing at it, with ports 80 and 443 open. Caddy gets and
   renews the certificate itself.
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
| `YOK_PASSWORD` | yes | its password; the server stores a hash of it, never the password |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of the two | from `claude setup-token` on your laptop; lasts a year |
| `CODEX_API_KEY` | one of the two | an OpenAI API key; stored on the server by `codex login` |
| `GH_TOKEN` | only if the repo is private | a token that can read the repository's contents |

## What a deploy does

`deploy.sh` runs on the server as the ssh user, in this order, and each step is safe to repeat:

1. **packages**: installs git, tmux, jq, curl, gh, ripgrep, ffmpeg, node and Caddy with apt, and
   claude, codex, agent-browser and ast-grep with npm, skipping what is present.
2. **config**: writes `SERVER_DOMAIN` to `~/.yok/.env`, the tokens to `~/.yok/secrets.env`
   (mode 600), and the domain, user and password hash to `/etc/caddy/.env`.
3. **caddy**: installs the Caddyfile and the drop-in that points Caddy at its env file, then
   validates and reloads.
4. **yok**: installs the tag with `install.sh`, which also moves the agent plugin and writes the
   `yok-remote` shortcut, then logs Codex in when it has a key.
5. **service**: installs the user unit, enables linger so it survives logout, restarts it, and
   drops an idle tmux server so the next run's session sees today's tokens.
6. **check**: waits for `/api/health` on loopback to answer with the tag's version.

The workflow then asks `https://SERVER_DOMAIN/api/health` with the login, the request a laptop
makes, and fails unless the version matches.

## Rotating a secret

Change it in GitHub and run the workflow by hand with the current tag. Runs in progress keep
their old tokens; the next run picks up the new ones.

## When it fails

- The check steps print the version the server answered, or nothing. On the box,
  `journalctl --user -u yok -f` is the server log and `sudo journalctl -u caddy -f` is Caddy's.
- A 403 on every request through Caddy means `SERVER_DOMAIN` differs from the domain Caddy
  serves. Both come from the same secret, so this points at a stale deploy.
- A deploy that failed before the service step left the previous version running.
