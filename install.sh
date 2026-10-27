#!/bin/sh
# Installs or upgrades yok: the binary for this machine, then the agent plugin at its version.
#   gh api repos/vertexcover-io/yok/contents/install.sh -H "Accept: application/vnd.github.raw" | sh
# The repo is private: it needs gh, logged in with an account that can see it.
# YOK_VERSION=vX.Y.Z picks a release; YOK_AGENTS="claude" limits the plugin install.
set -eu

REPO="vertexcover-io/yok"
BIN_DIR="$HOME/.yok/bin"

say() { printf '%s\n' "$*"; }
die() { printf 'yok install: %s\n' "$*" >&2; exit 1; }

asset_name() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "no yok build for $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "no yok build for $(uname -m)" ;;
  esac
  printf 'yok-%s-%s' "$os" "$arch"
}

NO_ACCESS="yok is private: install the GitHub CLI and run gh auth login with an account that can see $REPO"

# Puts the asset and checksums.txt in $2. The repo is private, so gh downloads with the user's
# GitHub access; YOK_RELEASE_URL is a plain server, for tests.
download_release() {
  if [ -n "${YOK_RELEASE_URL:-}" ]; then
    curl -fsSL "$YOK_RELEASE_URL/$1" -o "$2/$1" || die "could not download $1 from $YOK_RELEASE_URL"
    curl -fsSL "$YOK_RELEASE_URL/checksums.txt" -o "$2/checksums.txt" || die "could not download checksums.txt from $YOK_RELEASE_URL"
    return 0
  fi
  command -v gh >/dev/null 2>&1 || die "$NO_ACCESS"
  # shellcheck disable=SC2086 # an empty YOK_VERSION must vanish, so gh takes the latest release
  gh release download ${YOK_VERSION:-} -R "$REPO" -p "$1" -p checksums.txt -D "$2" ||
    die "could not download $1 from $REPO. $NO_ACCESS"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

install_binary() {
  asset=$(asset_name)
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  download_release "$asset" "$tmp"
  # awk, not grep: it matches the asset name as a whole field.
  want=$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/checksums.txt")
  [ -n "$want" ] || die "checksums.txt has no line for $asset; nothing installed"
  [ "$(sha256_of "$tmp/$asset")" = "$want" ] || die "checksum mismatch for $asset; nothing installed"
  mkdir -p "$BIN_DIR"
  chmod 755 "$tmp/$asset"
  mv "$tmp/$asset" "$BIN_DIR/yok"
  say "Installed $BIN_DIR/yok"
}

# yok-remote is `yok remote`: it runs the yok beside it, so both are always one version.
install_remote_shortcut() {
  # shellcheck disable=SC2016 # $0 and $@ belong to yok-remote, not to this installer
  printf '#!/bin/sh\nexec "$(dirname "$0")/yok" remote "$@"\n' > "$BIN_DIR/yok-remote"
  chmod 755 "$BIN_DIR/yok-remote"
}

add_to_path() {
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc" ;;
    *) rc="$HOME/.profile" ;;
  esac
  # Guarded, so a shell that re-reads this file inside an agent session never puts
  # ~/.yok/bin ahead of the session's own yok.
  line='case ":$PATH:" in *":$HOME/.yok/bin:"*) ;; *) export PATH="$HOME/.yok/bin:$PATH" ;; esac'
  if [ -f "$rc" ] && grep -qF "$line" "$rc"; then return 0; fi
  printf '\n%s\n' "$line" >> "$rc"
  say "Added ~/.yok/bin to PATH in $rc. Open a new shell to use yok."
}

check_tools() {
  for tool in git tmux; do
    command -v "$tool" >/dev/null 2>&1 && continue
    case "$(uname -s)" in
      Darwin) say "yok needs $tool to run an agent: brew install $tool" ;;
      *) say "yok needs $tool to run an agent: sudo apt-get install $tool (or your package manager)" ;;
    esac
  done
}

# yok picks the agents itself when none is named, so it alone knows which agents it supports.
install_plugins() {
  args=""
  for agent in $(printf '%s' "${YOK_AGENTS:-}" | tr ',' ' '); do args="$args --agent $agent"; done
  # shellcheck disable=SC2086 # args is a list of flags
  "$BIN_DIR/yok" plugin install $args
}

install_binary
install_remote_shortcut
add_to_path
check_tools
install_plugins
say "yok $("$BIN_DIR/yok" --version) is ready. Run yok doctor inside a project."
