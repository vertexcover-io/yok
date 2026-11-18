"""
Inventory for provision.py. One box, described by environment variables.

Required:
  DEPLOY_HOST     ip or hostname of the box
  SERVER_DOMAIN   public domain yok is served on; with Caddy, DNS must already point at the box
  DEPLOY_PUBKEY   path to the public key the Deploy workflow logs in with (on exe.dev the ssh proxy
                  checks the account's keys instead, so also `ssh exe.dev ssh-key add` it)
  YOK_USER        the dashboard login Caddy asks for (with PROXY=caddy only)
  YOK_PASSWORD    its password; only a bcrypt hash of it reaches the box (PROXY=caddy only)

Optional:
  PROXY           caddy (default): install Caddy, serve SERVER_DOMAIN with auto TLS, bind yok
                  to loopback. external: a proxy of the box's own (a web panel's nginx)
                  already terminates TLS and asks for the login; skip Caddy and the firewall
  YOK_BIND        with PROXY=external, the address yok listens on. yok has no login of its
                  own, so this must be an address only the proxy reaches; 0.0.0.0 is right
                  only on a box whose public side is the proxy. No default: it is never guessed
  CADDY_HTTP_PORT with PROXY=caddy on a box behind an edge that already terminates TLS (exe.dev):
                  Caddy serves plain http on this port, with the login, and the firewall is
                  skipped. Unset: Caddy serves SERVER_DOMAIN with https on 80 and 443
  APP_USER        user that owns ~/.yok, runs the server and the runs, and that the Deploy
                  workflow logs in as (default: yok, created). exedev on exe.dev
  ADMIN_USER      user with sudo that provisioning logs in as (default: root)
"""

import os
import sys
from pathlib import Path
from typing import Mapping

import bcrypt

_REQUIRED = ("DEPLOY_HOST", "SERVER_DOMAIN", "DEPLOY_PUBKEY")
_PROXIES = ("caddy", "external")


def _bind(env: Mapping[str, str], proxy: str) -> str:
    if proxy == "caddy":
        return "127.0.0.1"
    bind = env.get("YOK_BIND", "").strip()
    if not bind:
        sys.exit(
            "inventory.py: PROXY=external needs YOK_BIND, the address only the proxy reaches,"
            " since yok has no login of its own"
        )
    return bind


def _caddy_http_port(env: Mapping[str, str], proxy: str) -> int | None:
    raw = env.get("CADDY_HTTP_PORT", "").strip()
    if proxy != "caddy" or not raw:
        return None
    if not raw.isdigit() or not 1 <= int(raw) <= 65535:
        sys.exit(f"inventory.py: CADDY_HTTP_PORT must be a port number, not {raw!r}")
    return int(raw)


def _password_hash(env: Mapping[str, str], proxy: str) -> str | None:
    if proxy != "caddy":
        return None
    missing = [key for key in ("YOK_USER", "YOK_PASSWORD") if not env.get(key)]
    if missing:
        sys.exit(f"inventory.py: PROXY=caddy needs {', '.join(missing)}")
    return bcrypt.hashpw(env["YOK_PASSWORD"].encode(), bcrypt.gensalt()).decode()


def _pubkey(env: Mapping[str, str]) -> str:
    path = Path(env["DEPLOY_PUBKEY"]).expanduser()
    if not path.is_file():
        sys.exit(f"inventory.py: DEPLOY_PUBKEY is not a file: {path}")
    return path.read_text().strip()


def build_inventory(env: Mapping[str, str]) -> list[tuple[str, dict]]:
    missing = [key for key in _REQUIRED if not env.get(key)]
    if missing:
        sys.exit(f"inventory.py: missing environment variables: {', '.join(missing)}")
    proxy = env.get("PROXY") or "caddy"
    if proxy not in _PROXIES:
        sys.exit(f"inventory.py: PROXY must be one of {', '.join(_PROXIES)}")
    admin_user = env.get("ADMIN_USER") or "root"
    caddy_http_port = _caddy_http_port(env, proxy)
    return [
        (
            env["DEPLOY_HOST"],
            {
                "ssh_user": admin_user,
                "_sudo": admin_user != "root",
                "domain": env["SERVER_DOMAIN"],
                "proxy": proxy,
                "bind": _bind(env, proxy),
                "caddy_http_port": caddy_http_port,
                # Only a box whose own interface is public needs one; behind an edge there is none.
                "firewall": proxy == "caddy" and caddy_http_port is None,
                "app_user": env.get("APP_USER") or "yok",
                "yok_user": env.get("YOK_USER") or "",
                "password_hash": _password_hash(env, proxy),
                # Never sent to the box: provision.py only checks it against the hash already there.
                "yok_password": env.get("YOK_PASSWORD", "") if proxy == "caddy" else "",
                "deploy_pubkey": _pubkey(env),
            },
        )
    ]


# pyinfra imports this file for the `box` list; a test imports build_inventory alone.
if "pyinfra" in sys.modules:
    box = build_inventory(os.environ)
