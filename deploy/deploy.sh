#!/bin/sh
# Deploys one yok release to this machine, as the user who owns the runs. Safe to run again:
# every step checks before it acts or writes a whole file, so a rerun converges.
#   sh deploy.sh vX.Y.Z
# with /tmp/yok-deploy/ holding secrets.env, Caddyfile and yok.service, as deploy.yml copies them.
set -eu

STAGE=/tmp/yok-deploy
YOK_HOME="$HOME/.yok"
PORT=7777
REPO=vertexcover-io/yok

say() { printf '==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

TAG="${1:-}"
[ -n "$TAG" ] || die "usage: deploy.sh vX.Y.Z"

# secrets.env is the one file the workflow wrote from the GitHub secrets. It is sourced here and
# never echoed. SERVER_DOMAIN, YOK_USER and YOK_PASSWORD must be present; one agent credential
# must be, or the server could never run anything; GH_TOKEN is needed only while the repo is
# private.
load_secrets() {
  [ -f "$STAGE/secrets.env" ] || die "$STAGE/secrets.env is missing; deploy.yml writes it from the GitHub secrets"
  set -a; . "$STAGE/secrets.env"; set +a
  missing=""
  for name in SERVER_DOMAIN YOK_USER YOK_PASSWORD; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || missing="$missing $name"
  done
  [ -z "$missing" ] || die "secrets.env lacks:$missing"
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${CODEX_API_KEY:-}" ] ||
    die "secrets.env has neither CLAUDE_CODE_OAUTH_TOKEN nor CODEX_API_KEY; a run needs one agent"
}

# Everything a run's doctor looks for, plus Caddy and both agents. A tool already on PATH is
# skipped, so this is quick after the first time.
install_packages() {
  say "packages"
  for tool in git tmux jq curl gh rg ffmpeg node caddy; do
    command -v "$tool" >/dev/null 2>&1 && continue
    sudo apt-get update -qq
    sudo apt-get install -y -qq git tmux jq curl gh ripgrep ffmpeg nodejs npm caddy
    break
  done
  for tool in claude codex agent-browser ast-grep; do
    command -v "$tool" >/dev/null 2>&1 && continue
    sudo npm install -g --silent @anthropic-ai/claude-code @openai/codex agent-browser @ast-grep/cli
    agent-browser install --with-deps
    break
  done
}

# Three files, each owned by the thing that reads it. The password hash is made here, so the
# plain password lives only in this process.
write_config() {
  say "config"
  install -d -m 700 "$YOK_HOME"
  printf 'SERVER_DOMAIN=%s\n' "$SERVER_DOMAIN" > "$YOK_HOME/.env"
  {
    [ -z "${GH_TOKEN:-}" ] || printf 'GH_TOKEN=%s\n' "$GH_TOKEN"
    [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN"
    [ -z "${CODEX_API_KEY:-}" ] || printf 'CODEX_API_KEY=%s\n' "$CODEX_API_KEY"
  } | install -m 600 /dev/stdin "$YOK_HOME/secrets.env"
  hash=$(printf '%s' "$YOK_PASSWORD" | caddy hash-password)
  printf 'SERVER_DOMAIN=%s\nYOK_USER=%s\nYOK_PASSWORD_HASH=%s\n' "$SERVER_DOMAIN" "$YOK_USER" "$hash" |
    sudo install -m 600 -o root -g root /dev/stdin /etc/caddy/.env
}

configure_caddy() {
  say "caddy"
  sudo install -m 644 "$STAGE/Caddyfile" /etc/caddy/Caddyfile
  sudo install -d /etc/systemd/system/caddy.service.d
  printf '[Service]\nEnvironmentFile=/etc/caddy/.env\n' |
    sudo install -m 644 /dev/stdin /etc/systemd/system/caddy.service.d/env.conf
  sudo caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/.env
  sudo systemctl daemon-reload
  sudo systemctl enable --now caddy
  sudo systemctl reload caddy
}

# install.sh comes from the tag it installs, through gh so a private repo works with GH_TOKEN.
# yok update must not run here: it restarts the server outside systemd. install.sh swaps the
# binary only; start_service brings the new version up.
install_yok() {
  say "yok $TAG"
  gh api "repos/$REPO/contents/install.sh?ref=$TAG" -H "Accept: application/vnd.github.raw" |
    YOK_VERSION="$TAG" sh
  installed=$("$YOK_HOME/bin/yok" --version)
  [ "$installed" = "${TAG#v}" ] || die "installed yok is $installed, not ${TAG#v}"
  if [ -n "${CODEX_API_KEY:-}" ]; then
    printf '%s' "$CODEX_API_KEY" | codex login --with-api-key
  fi
}

# The unit's environment is what every run's tmux session, and so every agent, inherits.
start_service() {
  say "service"
  install -d "$HOME/.config/systemd/user"
  install -m 644 "$STAGE/yok.service" "$HOME/.config/systemd/user/yok.service"
  systemctl --user daemon-reload
  systemctl --user enable yok
  systemctl --user restart yok
  sudo loginctl enable-linger "$USER"
  # A tmux server with no sessions still holds the environment it was born with. Dropping an
  # idle one means the next run's session sees today's tokens. A busy one is left alone.
  if [ -z "$(tmux -L yok list-sessions 2>/dev/null)" ]; then
    tmux -L yok kill-server 2>/dev/null || true
  fi
}

# On loopback, so a failure here is yok's and not Caddy's. deploy.yml then checks through Caddy.
check() {
  say "check"
  version=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    version=$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | jq -r .version) && break
    sleep 2
  done
  [ "$version" = "${TAG#v}" ] ||
    die "the server answers '${version}', not ${TAG#v}; see: journalctl --user -u yok"
  say "yok ${TAG#v} is serving on 127.0.0.1:$PORT behind https://$SERVER_DOMAIN"
}

load_secrets
install_packages
write_config
configure_caddy
install_yok
start_service
check
rm -rf "$STAGE"
