"""
Provision a fresh Debian or Ubuntu box to run the yok server. Run once per machine; safe to run
again. It leaves the tools, the user, the unit and the config in place; the Deploy workflow
then puts a release on the box and starts it.

Usage, from the deploy/ directory (templates are resolved relative to the cwd):

  pip install -r requirements.txt
  export DEPLOY_HOST=... SERVER_DOMAIN=... YOK_USER=... YOK_PASSWORD=... \\
         DEPLOY_PUBKEY=~/.ssh/yok_deploy.pub
  # on exe.dev, whose edge does https and forwards to one port, add:
  #   CADDY_HTTP_PORT=8080 APP_USER=exedev ADMIN_USER=exedev
  # behind a proxy that also does the login (a web panel's nginx), add instead:
  #   PROXY=external YOK_BIND=<address only that proxy reaches>
  pyinfra inventory.py provision.py --dry     # show what would change
  pyinfra inventory.py provision.py -y        # apply
"""

import re
from io import StringIO

import bcrypt
from pyinfra import host
from pyinfra.facts.files import Directory, File, FileContents, Link
from pyinfra.facts.server import Which
from pyinfra.operations import apt, files, server, systemd

d = host.data

APP_USER = d.app_user
HOME = f"/home/{APP_USER}"
YOK_HOME = f"{HOME}/.yok"
CADDY = d.proxy == "caddy"
CADDY_KEYRING = "/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
# Everything a run's doctor looks for, and both agents.
NPM_TOOLS = {
    "claude": "@anthropic-ai/claude-code",
    "codex": "@openai/codex",
    "agent-browser": "agent-browser",
    "ast-grep": "@ast-grep/cli",
}
# sudo -H, so HOME is the app user's; a login shell (sudo -i) would escape the command's $ signs.
AS_APP_USER = {"_sudo": True, "_sudo_user": APP_USER}

apt.packages(
    name="Base packages",
    packages=["git", "tmux", "jq", "curl", "gh", "ripgrep", "ffmpeg", "nodejs", "npm"]
    + (["ufw"] if d.firewall else []),
    update=True,
    cache_time=3600,
)

if CADDY and not host.get_fact(File, path=CADDY_KEYRING):
    server.shell(
        name="Caddy signing key",
        commands=[
            "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key"
            f" | gpg --dearmor -o {CADDY_KEYRING}",
        ],
    )

if CADDY:
    files.download(
        name="Caddy apt source",
        src="https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt",
        dest="/etc/apt/sources.list.d/caddy-stable.list",
    )
    apt.packages(name="Caddy", packages=["caddy"], update=True, cache_time=3600)

# One package at a time: an image may ship an agent as a plain binary, which npm would refuse
# to overwrite, and a failure names the package.
for tool, package in NPM_TOOLS.items():
    if not host.get_fact(Which, command=tool):
        server.shell(name=f"npm: {package}", commands=[f"npm install -g --silent {package}"])

server.user(
    name=f"User {APP_USER}",
    user=APP_USER,
    shell="/bin/bash",
    public_keys=[d.deploy_pubkey],
    ensure_home=True,
)

if not host.get_fact(Directory, path=f"{HOME}/.agent-browser/browsers"):
    server.shell(
        name="agent-browser: browsers",
        commands=["agent-browser install --with-deps"],
        **AS_APP_USER,
    )

files.directory(name="yok home", path=YOK_HOME, user=APP_USER, group=APP_USER, mode="700")

# Written every run: it holds no generated secret, so a changed domain or bind converges.
files.put(
    name="yok .env",
    src=StringIO(f"SERVER_DOMAIN={d.domain}\nYOK_BIND={d.bind}\n"),
    dest=f"{YOK_HOME}/.env",
    user=APP_USER,
    group=APP_USER,
    mode="600",
)

# A fresh bcrypt hash differs every run; the one already in the Caddyfile is kept while it still
# matches the password, so an unchanged password is no change.
def current_password_hash() -> str:
    lines = host.get_fact(FileContents, path="/etc/caddy/Caddyfile") or []
    found = re.search(r"\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}", "\n".join(lines))
    if found and bcrypt.checkpw(d.yok_password.encode(), found.group().encode()):
        return found.group()
    return d.password_hash


if CADDY:
    caddyfile = files.template(
        name="Caddyfile",
        src="templates/Caddyfile.j2",
        dest="/etc/caddy/Caddyfile",
        user="root",
        group="caddy",
        mode="640",
        domain=d.domain,
        http_port=d.caddy_http_port,
        yok_user=d.yok_user,
        password_hash=current_password_hash(),
    )
    systemd.service(
        name="Caddy running",
        service="caddy",
        running=True,
        enabled=True,
        reloaded=True,
        _if=caddyfile.did_change,
    )

if d.firewall:
    server.shell(
        name="Firewall: allow ssh, http, https; enable",
        commands=[
            "ufw allow 22/tcp",
            "ufw allow 80/tcp",
            "ufw allow 443/tcp",
            "ufw --force enable",
        ],
    )

# Linger, so the user manager exists without a login and the server outlives every ssh session.
if not host.get_fact(File, path=f"/var/lib/systemd/linger/{APP_USER}"):
    server.shell(name="Linger", commands=[f"loginctl enable-linger {APP_USER}"])

files.put(
    name="yok user unit",
    src="yok.service",
    dest=f"{HOME}/.config/systemd/user/yok.service",
    user=APP_USER,
    group=APP_USER,
    mode="644",
)

# Enabled, not started: the binary arrives with the first Deploy. An ssh session that skipped
# logind has no XDG_RUNTIME_DIR, and without it systemctl --user cannot find the user manager.
if not host.get_fact(Link, path=f"{HOME}/.config/systemd/user/default.target.wants/yok.service"):
    server.shell(
        name="yok unit enabled",
        commands=[
            'export XDG_RUNTIME_DIR="/run/user/$(id -u)"'
            " && systemctl --user daemon-reload && systemctl --user enable yok",
        ],
        **AS_APP_USER,
    )

# claude asks a first-time user to pick a theme before it reads its prompt, and a run's session
# would wait on that menu forever. Marking onboarding done sends it straight to the prompt.
CLAUDE_SETTINGS = "\n".join(host.get_fact(FileContents, path=f"{HOME}/.claude.json") or [])
if '"hasCompletedOnboarding": true' not in CLAUDE_SETTINGS:
    server.shell(
        name="claude onboarding done",
        commands=[
            f'f="{HOME}/.claude.json"; [ -s "$f" ] || printf "{{}}\\n" | install -m 600 /dev/stdin "$f";'
            ' jq ". + {hasCompletedOnboarding: true, theme: \\"dark\\"}" "$f" | install -m 600 /dev/stdin "$f.new"'
            ' && mv "$f.new" "$f"',
        ],
        **AS_APP_USER,
    )
