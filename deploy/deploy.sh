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

# Checked again here, since the tag lands on a shell line below and this script may be run by hand.
TAG="${1:-}"
[ -n "$TAG" ] || die "usage: deploy.sh vX.Y.Z"
case "$TAG" in
  *[!0-9A-Za-z.-]*) die "'$TAG' is not a release tag like v0.0.8" ;;
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "'$TAG' is not a release tag like v0.0.8" ;;
esac

# secrets.env is the one file the workflow wrote from the GitHub secrets. It is sourced here and
# never echoed. SERVER_DOMAIN, YOK_USER and YOK_PASSWORD must be present; one agent credential
# must be, or the server could never run anything; GH_TOKEN is needed only while the repo is
# private. PROXY is caddy (this script runs Caddy) or own (something already in front of the box
# does https and the login, and the server listens on YOK_BIND so that proxy can reach it).
# yok has no login of its own, so with an own proxy the bind address is never guessed: whoever
# deploys names the interface the proxy reaches, and nothing else may.
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
  PROXY="${PROXY:-caddy}"
  case "$PROXY" in
    caddy) BIND=127.0.0.1 ;;
    own)
      [ -n "${YOK_BIND:-}" ] ||
        die "PROXY=own needs YOK_BIND: the address only the proxy reaches, since yok has no login of its own"
      BIND="$YOK_BIND"
      ;;
    *) die "PROXY is '$PROXY'; it must be caddy or own" ;;
  esac
}

own_proxy() { [ "$PROXY" = own ]; }

# Everything a run's doctor looks for, plus both agents, plus Caddy when this script runs it. A
# tool already on PATH is skipped, so this is quick after the first time.
install_packages() {
  say "packages"
  caddy=caddy
  own_proxy && caddy=""
  for tool in git tmux jq curl gh rg ffmpeg node $caddy; do
    command -v "$tool" >/dev/null 2>&1 && continue
    sudo apt-get update -qq
    sudo apt-get install -y -qq git tmux jq curl gh ripgrep ffmpeg nodejs npm $caddy
    break
  done
  # One package at a time: an image may ship an agent as a plain binary, which npm would refuse
  # to overwrite, and a failure names the package.
  for pair in claude=@anthropic-ai/claude-code codex=@openai/codex agent-browser=agent-browser ast-grep=@ast-grep/cli; do
    tool="${pair%%=*}"
    command -v "$tool" >/dev/null 2>&1 && continue
    sudo npm install -g --silent "${pair#*=}" || die "npm could not install ${pair#*=}"
    [ "$tool" = agent-browser ] && agent-browser install --with-deps
  done
}

# Three files, each owned by the thing that reads it; with an own proxy, only yok's two. The
# password hash is made here, so the plain password lives only in this process.
write_config() {
  say "config"
  install -d -m 700 "$YOK_HOME"
  printf 'SERVER_DOMAIN=%s\nYOK_BIND=%s\n' "$SERVER_DOMAIN" "$BIND" > "$YOK_HOME/.env"
  {
    [ -z "${GH_TOKEN:-}" ] || printf 'GH_TOKEN=%s\n' "$GH_TOKEN"
    [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN"
    [ -z "${CODEX_API_KEY:-}" ] || printf 'CODEX_API_KEY=%s\n' "$CODEX_API_KEY"
  } | install -m 600 /dev/stdin "$YOK_HOME/secrets.env"
  own_proxy && return 0
  hash=$(printf '%s' "$YOK_PASSWORD" | caddy hash-password)
  printf 'SERVER_DOMAIN=%s\nYOK_USER=%s\nYOK_PASSWORD_HASH=%s\n' "$SERVER_DOMAIN" "$YOK_USER" "$hash" |
    sudo install -m 600 -o root -g root /dev/stdin /etc/caddy/.env
}

configure_caddy() {
  if own_proxy; then
    say "caddy: skipped, PROXY=own"
    return 0
  fi
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

# install.sh comes from the tag it installs. With GH_TOKEN it goes through gh, so a private repo
# works; without one the repo is public, and the raw file and the release assets are plain
# downloads, which is what install.sh's YOK_RELEASE_URL takes. yok update must not run here: it
# restarts the server outside systemd. install.sh swaps the binary only; start_service brings
# the new version up.
install_yok() {
  say "yok $TAG"
  script=$(mktemp)
  if [ -n "${GH_TOKEN:-}" ]; then
    gh api "repos/$REPO/contents/install.sh?ref=$TAG" -H "Accept: application/vnd.github.raw" > "$script" ||
      die "could not fetch install.sh at $TAG with gh"
    YOK_VERSION="$TAG" sh "$script"
  else
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$TAG/install.sh" -o "$script" ||
      die "could not fetch install.sh at $TAG; set GH_TOKEN if the repo is private"
    YOK_VERSION="$TAG" YOK_RELEASE_URL="https://github.com/$REPO/releases/download/$TAG" sh "$script"
  fi
  rm -f "$script"
  installed=$("$YOK_HOME/bin/yok" --version)
  [ "$installed" = "${TAG#v}" ] || die "installed yok is $installed, not ${TAG#v}"
  if [ -n "${CODEX_API_KEY:-}" ]; then
    printf '%s' "$CODEX_API_KEY" | codex login --with-api-key
  fi
}

# The unit's environment is what every run's tmux session, and so every agent, inherits.
# Linger first, so the user manager exists and outlives this login; an ssh session that skipped
# logind has no XDG_RUNTIME_DIR, and without it systemctl --user cannot find that manager.
start_service() {
  say "service"
  sudo loginctl enable-linger "$USER"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  install -d "$HOME/.config/systemd/user"
  install -m 644 "$STAGE/yok.service" "$HOME/.config/systemd/user/yok.service"
  systemctl --user daemon-reload
  systemctl --user enable yok
  systemctl --user restart yok
  # A tmux server with no sessions still holds the environment it was born with. Dropping an
  # idle one means the next run's session sees today's tokens. A busy one is left alone.
  if [ -z "$(tmux -L yok list-sessions 2>/dev/null)" ]; then
    tmux -L yok kill-server 2>/dev/null || true
  fi
}

# On the box, so a failure here is yok's and not the proxy's. deploy.yml then checks through it.
# The port answers 503 while the app loads, which takes a small box half a minute.
check() {
  say "check"
  # curl's status, not jq's: a pipe would report jq's success on an empty body.
  version=""
  for _ in $(seq 1 30); do
    if body=$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then
      version=$(printf '%s' "$body" | jq -r .version)
      break
    fi
    sleep 2
  done
  [ "$version" = "${TAG#v}" ] ||
    die "the server answers '${version}', not ${TAG#v}; see: journalctl --user -u yok"
  say "yok ${TAG#v} is serving on $BIND:$PORT behind https://$SERVER_DOMAIN"
}

load_secrets
install_packages
write_config
configure_caddy
install_yok
start_service
check
rm -rf "$STAGE"
