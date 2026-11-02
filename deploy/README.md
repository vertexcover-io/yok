# Deploying the yok server

One Linux box runs the yok server as a systemd user unit behind a proxy that does https and the
login. Two components put it there, and they run at different times.

`provision.py` is a pyinfra script that a person runs once per machine. It installs the tools
a run needs, creates the user that owns the runs, writes the server's config, installs the
unit, and sets up Caddy unless the box already has a proxy.

`.github/workflows/deploy.yml` is a GitHub Actions workflow that runs on every stable release.
It logs in as that user, writes the agent tokens, installs the release with `install.sh`,
restarts the unit and checks the version, on the box and then through the proxy.

| | Runs | Does |
|---|---|---|
| `provision.py` | once per machine, by a person | tools, user, `~/.yok/.env`, unit, linger, Caddy |
| `deploy.yml` | on every stable release, by GitHub; by hand with any tag | tokens, binary, restart, health check |

The interface between the two is small: a user with the deploy key, `~/.yok/.env` and the
unit file. Provisioning never needs to run again unless one of those changes. The workflow
never needs sudo.

```
ONCE      laptop ── pyinfra over ssh, sudo ──► box: apt, npm, user, ~/.yok/.env, yok.service, Caddy
RELEASE   release.yml ──dispatch tag──► deploy.yml ── ssh as the user, no sudo ──► box:
             ~/.yok/secrets.env, install.sh TAG, systemctl --user restart yok, /api/health
             then curl https://SERVER_DOMAIN/api/health with the login from the runner
```

## Contents

- [Prerequisites](#prerequisites)
- [Provisioning a machine](#provisioning-a-machine)
- [Configuration reference](#configuration-reference)
- [Behind a platform proxy](#behind-a-platform-proxy)
- [Connecting the workflow to the server](#connecting-the-workflow-to-the-server)
- [What a deploy does](#what-a-deploy-does)
- [Rotating a secret](#rotating-a-secret)
- [When it fails](#when-it-fails)

## Prerequisites

1. **A machine** running Debian or Ubuntu, with your ssh public key installed for root or for
   a user with passwordless sudo. Provisioning logs in with that key. Nothing else needs to be
   installed on it.
2. **A domain name** with a DNS record pointing at the machine, and ports 80 and 443 open.
   Provisioning installs Caddy, which gets and renews the certificate itself, and issuance
   fails if the domain does not resolve yet. Behind a platform proxy, whatever that platform
   needs instead.
3. **An agent credential**: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on your
   laptop (lasts a year), or `CODEX_API_KEY`. These go to GitHub, not to provisioning.
4. **A deploy key pair**, the ssh key the workflow logs in with:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/yok_deploy -N ""
   ```
   Provisioning installs the public half. The private half goes to GitHub in
   [Connecting the workflow to the server](#connecting-the-workflow-to-the-server).
5. **Python 3.10 or newer** on the laptop that runs provisioning.

## Provisioning a machine

```sh
cd deploy
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

export DEPLOY_HOST=1.2.3.4 SERVER_DOMAIN=yok.example.org \
       YOK_USER=me YOK_PASSWORD=... \
       DEPLOY_PUBKEY=~/.ssh/yok_deploy.pub

ssh root@1.2.3.4 true                       # once, so the host key is known
pyinfra inventory.py provision.py --dry     # show what would change
pyinfra inventory.py provision.py -y        # apply
```

The dry run connects, reads the machine's state and lists every change it would make without
making any. The apply run makes them. Provisioning is safe to repeat: every operation checks
before it acts, so a second run reports nothing to do.

On completion the box has the tools, the `yok` user with the deploy key, `~/.yok/.env`, the
unit enabled but not started, and Caddy serving `SERVER_DOMAIN` with the login. The first
Deploy run installs the binary and starts the server.

## Configuration reference

Configuration is passed as environment variables, read by `inventory.py`. If a required
variable is missing, provisioning stops and names it.

| Variable | Required | Meaning |
|---|---|---|
| `DEPLOY_HOST` | yes | ip address or hostname of the machine |
| `SERVER_DOMAIN` | yes | public domain yok is served on; written to `~/.yok/.env`, and yok's Host guard answers 403 to any other `Host` |
| `DEPLOY_PUBKEY` | yes | path to the public half of the deploy key |
| `YOK_USER`, `YOK_PASSWORD` | with Caddy | the login Caddy asks for. Only a bcrypt hash of the password reaches the box, in the Caddyfile |
| `PROXY` | no | `caddy` (default) installs Caddy to terminate https and ask for the login. `external` skips Caddy and the firewall, for a box that already has a proxy |
| `YOK_BIND` | with `external` | the address yok listens on so the proxy can reach it. yok has no login of its own, so this must be an address only the proxy reaches: a private interface, or `0.0.0.0` only on a box whose public side is the proxy. With Caddy it is always `127.0.0.1` |
| `APP_USER` | no | the user that owns `~/.yok`, runs the server and the runs, and that the workflow logs in as. Default `yok`, created by provisioning |
| `ADMIN_USER` | no | user provisioning logs in as. Default `root`; any other user needs passwordless sudo |

## Behind a platform proxy

Some platforms, such as exe.dev, already terminate https, ask for a login, and forward to a
port on the machine, and route ssh through their own proxy rather than the machine's
`authorized_keys`. Provisioning such a machine differs in four ways:

```sh
export PROXY=external YOK_BIND=0.0.0.0 APP_USER=exedev ADMIN_USER=exedev \
       DEPLOY_HOST=NAME.exe.xyz SERVER_DOMAIN=NAME.exe.xyz
```

- `PROXY=external` skips Caddy and the firewall. `YOK_BIND=0.0.0.0` is right there because the
  VM has only private addresses; its public side is the platform's edge. `ssh exe.dev share
  port NAME 7777` is what makes the edge forward `https://NAME.exe.xyz/` to yok. Leave the VM
  private: a browser then signs in at exe.dev, and `ssh exe.dev share add NAME someone@example.com`
  admits each dashboard user.
- `APP_USER=exedev ADMIN_USER=exedev`, because the exe.dev ssh proxy ignores the username and
  always lands on `exedev`. `DEPLOY_USER` in the `production` environment is `exedev` too.
- The deploy key is registered with the platform account, scoped to this VM, not on the
  machine:
  ```sh
  ssh exe.dev ssh-key add --vm=NAME --ssh-user=exedev "$(cat ~/.ssh/yok_deploy.pub)"
  ```
- The login is the platform's. A browser signs in at exe.dev; a script sends a VM token as the
  Basic auth password with any username, which is what `yok-remote` and the workflow's final
  check do. Mint one with `ssh exe.dev ssh-key generate-api-key --vm=NAME --label=deploy` and
  store it as `YOK_PASSWORD` in GitHub; `YOK_USER` can be anything. Each person mints their own
  for the laptop: `YOK_SERVER_PASSWORD=<token> yok-remote login https://NAME.exe.xyz --user me`.
- `SSH_HOST_KEY` is the proxy's key, which is RSA: `ssh-keyscan -t rsa NAME.exe.xyz`.

## Connecting the workflow to the server

The workflow logs in to the server over ssh to deploy. Do this after provisioning, because the
server's host key is read from the running machine.

In the repository, create an environment named `production` and add the following:

| Kind | Name | Value |
|---|---|---|
| variable | `DEPLOY_HOST` | the machine's ip address or hostname |
| variable | `DEPLOY_USER` | `APP_USER` from provisioning: `yok` by default, `exedev` on exe.dev |
| variable | `SERVER_DOMAIN` | the public domain, as given to provisioning |
| variable | `YOK_USER` | the login's name, as given to provisioning |
| secret | `SSH_PRIVATE_KEY` | contents of `~/.ssh/yok_deploy` |
| secret | `SSH_HOST_KEY` | one line from `ssh-keyscan -t ed25519 DEPLOY_HOST` |
| secret | `YOK_PASSWORD` | the login's password, as given to provisioning; the platform token with an external proxy |
| secret | `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY` | at least one; the agents a run can use |
| secret | `GH_TOKEN` | only while the repository is private: a token that can read its contents |
| secret | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | for Slack messages; a run whose config turns the notifier on stops without them |
| secret | `SLACK_MEMBER_ID` | the person the notifier mentions when a run needs someone |

The equivalent from the command line, in a checkout of the repository and with `DEPLOY_HOST`
and `SERVER_DOMAIN` still exported from provisioning:

```sh
gh api -X PUT "repos/{owner}/{repo}/environments/production"
gh variable set DEPLOY_HOST --env production --body "$DEPLOY_HOST"
gh variable set DEPLOY_USER --env production --body yok
gh variable set SERVER_DOMAIN --env production --body "$SERVER_DOMAIN"
gh variable set YOK_USER --env production --body "$YOK_USER"
gh secret set SSH_PRIVATE_KEY --env production < ~/.ssh/yok_deploy
ssh-keyscan -t ed25519 "$DEPLOY_HOST" | gh secret set SSH_HOST_KEY --env production
gh secret set YOK_PASSWORD --env production
gh secret set CLAUDE_CODE_OAUTH_TOKEN --env production
```

Repository-level secrets and variables also work; a value in the environment wins over one at
the repository. The environment adds the option of requiring a reviewer's approval before each
deployment.

Finally, run the workflow once by hand from **Actions, Deploy, Run workflow** with an existing
tag. The last step requests `https://SERVER_DOMAIN/api/health` with the login and fails unless
the version matches. From then on every stable release deploys itself; a pre-release
(`vX.Y.Z-rc.N`) is deployed by hand the same way, and the same manual run with an older tag
rolls back.

## What a deploy does

`deploy.sh` runs on the server as `DEPLOY_USER`, with the tokens on its stdin, under a lock so
two deploys queue rather than race:

1. **secrets**: writes stdin to `~/.yok/secrets.env` (mode 600) whole, so a secret removed in
   GitHub is removed here. One agent credential must be present.
2. **yok**: installs the tag with `install.sh`, which also installs the agent plugin and the
   `yok-remote` shortcut, then logs Codex in when it has a key.
3. **service**: restarts the unit, which reads `secrets.env` on start, and drops an idle tmux
   server so the next run's session sees today's tokens. A busy one is left alone.
4. **check**: waits for `/api/health` on loopback to answer with the tag's version.

The workflow then asks `https://SERVER_DOMAIN/api/health` with the login, the request a laptop
makes, and fails unless the version matches.

## Rotating a secret

- An agent or Slack token: change it in GitHub and run Deploy by hand with the current tag.
  Runs in progress keep their old tokens; the next run picks up the new ones.
- `YOK_PASSWORD`, `SERVER_DOMAIN` or `YOK_BIND`: provisioning owns them. Export the new value,
  run provisioning again, then update the GitHub variable or secret to match. On exe.dev the
  password is a platform token, so revoke the old one with `ssh exe.dev ssh-key` instead.
- The deploy key: generate a new pair, run provisioning with the new `DEPLOY_PUBKEY` (or
  `ssh exe.dev ssh-key add` it), replace `SSH_PRIVATE_KEY`.

## When it fails

- The check steps print the version the server answered, or nothing. On the box,
  `journalctl --user -u yok -f` is the server log and `sudo journalctl -u caddy -f` is Caddy's.
- A 403 on every request through the proxy means `SERVER_DOMAIN` differs from the `Host` the
  proxy forwards. With Caddy both come from the same variable, so this points at a stale
  `~/.yok/.env`: run provisioning again. With an external proxy, check that it passes `Host`
  through unchanged, port included.
- `deploy: ~/.yok is missing; run provision.py first` means the workflow reached a box that
  was never provisioned, or as the wrong user.
- A deploy that failed before the service step left the previous version running.
