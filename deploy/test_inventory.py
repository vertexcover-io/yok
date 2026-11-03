"""Tests for inventory.py: python3 -B deploy/test_inventory.py"""

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import bcrypt

sys.path.insert(0, str(Path(__file__).parent))
from inventory import build_inventory  # noqa: E402

PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake deploy@laptop\n"


def env(**overrides: str) -> dict[str, str]:
    base = {
        "DEPLOY_HOST": "box.example.org",
        "SERVER_DOMAIN": "yok.example.org",
        "YOK_USER": "yok",
        "YOK_PASSWORD": "hunter2",
    }
    base.update(overrides)
    return base


class BuildInventory(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.pubkey = Path(self.tmp.name) / "deploy.pub"
        self.pubkey.write_text(PUBKEY)
        self.base = env(DEPLOY_PUBKEY=str(self.pubkey))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def host(self, **overrides: str) -> dict:
        [(_, data)] = build_inventory({**self.base, **overrides})
        return data

    def exit_message(self, env_vars: dict[str, str]) -> str:
        with self.assertRaises(SystemExit) as caught:
            build_inventory(env_vars)
        return str(caught.exception)

    def test_missing_variables_are_named(self) -> None:
        message = self.exit_message({"DEPLOY_HOST": "box"})
        self.assertIn("SERVER_DOMAIN", message)
        self.assertIn("DEPLOY_PUBKEY", message)
        self.assertNotIn("DEPLOY_HOST", message)

    def test_host_is_the_deploy_host(self) -> None:
        [(host, _)] = build_inventory(self.base)
        self.assertEqual(host, "box.example.org")

    def test_caddy_is_the_default_and_binds_loopback(self) -> None:
        data = self.host(YOK_BIND="0.0.0.0")
        self.assertEqual(data["proxy"], "caddy")
        self.assertEqual(data["bind"], "127.0.0.1")

    def test_caddy_serves_the_domain_with_https_by_default(self) -> None:
        data = self.host()
        self.assertIsNone(data["caddy_http_port"])
        self.assertTrue(data["firewall"])

    def test_caddy_http_port_serves_plain_http_behind_an_edge_without_a_firewall(self) -> None:
        data = self.host(CADDY_HTTP_PORT="8080")
        self.assertEqual(data["caddy_http_port"], 8080)
        self.assertFalse(data["firewall"])
        self.assertEqual(data["bind"], "127.0.0.1")

    def test_caddy_http_port_must_be_a_port_number(self) -> None:
        self.assertIn("CADDY_HTTP_PORT", self.exit_message({**self.base, "CADDY_HTTP_PORT": "web"}))
        self.assertIn("CADDY_HTTP_PORT", self.exit_message({**self.base, "CADDY_HTTP_PORT": "70000"}))

    def test_external_has_no_caddy_port_and_no_firewall(self) -> None:
        data = self.host(PROXY="external", YOK_BIND="10.0.0.5", CADDY_HTTP_PORT="8080")
        self.assertIsNone(data["caddy_http_port"])
        self.assertFalse(data["firewall"])

    def test_caddy_needs_the_login(self) -> None:
        message = self.exit_message({**self.base, "YOK_PASSWORD": ""})
        self.assertIn("YOK_PASSWORD", message)

    def test_caddy_hashes_the_password_with_bcrypt_and_keeps_it_for_a_match(self) -> None:
        data = self.host()
        self.assertEqual(data["yok_user"], "yok")
        self.assertTrue(bcrypt.checkpw(b"hunter2", data["password_hash"].encode()))
        self.assertEqual(data["yok_password"], "hunter2")

    def test_external_carries_no_password(self) -> None:
        data = self.host(PROXY="external", YOK_BIND="10.0.0.5", YOK_PASSWORD="hunter2")
        self.assertEqual(data["yok_password"], "")

    def test_external_needs_an_explicit_bind(self) -> None:
        message = self.exit_message({**self.base, "PROXY": "external"})
        self.assertIn("YOK_BIND", message)

    def test_external_takes_the_bind_and_needs_no_login(self) -> None:
        data = self.host(PROXY="external", YOK_BIND="10.0.0.5", YOK_USER="", YOK_PASSWORD="")
        self.assertEqual(data["proxy"], "external")
        self.assertEqual(data["bind"], "10.0.0.5")
        self.assertIsNone(data["password_hash"])

    def test_unknown_proxy_exits(self) -> None:
        self.assertIn("PROXY", self.exit_message({**self.base, "PROXY": "nginx"}))

    def test_pubkey_must_be_a_file(self) -> None:
        message = self.exit_message({**self.base, "DEPLOY_PUBKEY": "/nope/deploy.pub"})
        self.assertIn("DEPLOY_PUBKEY", message)

    def test_pubkey_text_is_read_and_stripped(self) -> None:
        self.assertEqual(self.host()["deploy_pubkey"], PUBKEY.strip())

    def test_root_admin_needs_no_sudo(self) -> None:
        data = self.host()
        self.assertEqual(data["ssh_user"], "root")
        self.assertFalse(data["_sudo"])

    def test_other_admin_uses_sudo(self) -> None:
        data = self.host(ADMIN_USER="exedev")
        self.assertEqual(data["ssh_user"], "exedev")
        self.assertTrue(data["_sudo"])

    def test_app_user_defaults_to_yok(self) -> None:
        self.assertEqual(self.host()["app_user"], "yok")
        self.assertEqual(self.host(APP_USER="exedev")["app_user"], "exedev")


if __name__ == "__main__":
    unittest.main()
