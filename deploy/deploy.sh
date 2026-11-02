#!/bin/sh
# Puts one yok release on this machine, as the user who owns the runs, with no sudo. The box was
# set up by provision.py: tools, ~/.yok/.env, the user unit, linger. Safe to run again.
#   sh deploy.sh vX.Y.Z < secrets
# with the agent tokens on stdin as KEY=VALUE lines, which is how deploy.yml sends them.
set -eu

YOK_HOME="$HOME/.yok"
PORT=7777
REPO=vertexcover-io/yok

say() { printf '==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

# Checked again here, since the tag lands on a shell line below and this script may be run by hand.
TAG="${1:-}"
[ -n "$TAG" ] || die "usage: deploy.sh vX.Y.Z < secrets"
case "$TAG" in
  *[!0-9A-Za-z.-]*) die "'$TAG' is not a release tag like v0.0.8" ;;
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "'$TAG' is not a release tag like v0.0.8" ;;
esac

# stdin becomes secrets.env whole, mode 600, so removing a secret in GitHub removes it here.
# The unit reads the file on start and every run's session inherits it. One agent credential
# must be present, or the server could never run anything.
write_secrets() {
  say "secrets"
  (umask 077; cat > "$YOK_HOME/secrets.env")
  set -a; . "$YOK_HOME/secrets.env"; set +a
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${CODEX_API_KEY:-}" ] ||
    die "secrets has neither CLAUDE_CODE_OAUTH_TOKEN nor CODEX_API_KEY; a run needs one agent"
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

# An ssh session that skipped logind has no XDG_RUNTIME_DIR, and without it systemctl --user
# cannot find the user manager that linger keeps alive.
start_service() {
  say "service"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user daemon-reload
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
  say "yok ${TAG#v} is serving on 127.0.0.1:$PORT"
}

# Two deploys at once would race on the binary and the service; the second waits its turn.
# stdin is read inside the lock, so a waiting deploy's secrets are not consumed early.
[ -d "$YOK_HOME" ] || die "$YOK_HOME is missing; run provision.py first"
exec 9> "$YOK_HOME/deploy.lock"
flock -w 300 9 || die "another deploy holds $YOK_HOME/deploy.lock"

write_secrets
install_yok
start_service
check
