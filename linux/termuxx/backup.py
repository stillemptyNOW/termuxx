"""Резервная копия в формате, совместимом с iOS-версией Termuxx.

Формат (docs/BACKUP_FORMAT.md):
{
  "format": "termuxx-backup", "version": 1, "createdAt": "2026-10-27T10:00:00Z", "app": "linux",
  "hosts": [...], "keys": [...], "snippets": [...], "knownHosts": {...},
  "secrets": null | {"kdf": "pbkdf2-sha256", "iterations": 200000, "salt": b64(16),
                      "cipher": "aes-256-gcm", "nonce": b64(12), "data": b64(ciphertext||tag)}
}
Зашифрованная часть — JSON {"passwords", "proxyPasswords", "privateKeys", "passphrases"} (словари id → строка).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import unicodedata
from dataclasses import dataclass
from typing import Optional

from termuxx.store import KeyItem, Server, Snippet, Store, norm_id, now_iso

FORMAT = "termuxx-backup"
VERSION = 1
ITERATIONS = 200_000


class BackupError(Exception):
    pass


@dataclass
class ImportSummary:
    servers: int = 0
    keys: int = 0
    snippets: int = 0
    secrets: int = 0
    secrets_skipped: bool = False

    def text(self) -> str:
        parts = [f"серверов: {self.servers}", f"ключей: {self.keys}", f"сниппетов: {self.snippets}"]
        if self.secrets:
            parts.append(f"секретов: {self.secrets}")
        text = "Импортировано — " + ", ".join(parts)
        if self.secrets_skipped:
            text += " (пароли и ключи пропущены)"
        return text


def _derive(password: str, salt: bytes, iterations: int) -> bytes:
    pw = unicodedata.normalize("NFC", password).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", pw, salt, iterations, dklen=32)


def _drop_nulls(value):
    """iOS опускает null-поля внутри объектов — делаем так же."""
    if isinstance(value, dict):
        return {k: _drop_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_drop_nulls(v) for v in value]
    return value


def _encrypt(payload: dict, password: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = _derive(password, salt, ITERATIONS)
    data = AESGCM(key).encrypt(nonce, json.dumps(payload, ensure_ascii=False).encode("utf-8"), None)
    return {
        "kdf": "pbkdf2-sha256",
        "iterations": ITERATIONS,
        "salt": base64.b64encode(salt).decode(),
        "cipher": "aes-256-gcm",
        "nonce": base64.b64encode(nonce).decode(),
        "data": base64.b64encode(data).decode(),
    }


def _decrypt(secrets: dict, password: str) -> dict:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if secrets.get("kdf") != "pbkdf2-sha256" or secrets.get("cipher") != "aes-256-gcm":
        raise BackupError("Неизвестный способ шифрования в файле.")
    try:
        salt = base64.b64decode(secrets["salt"])
        nonce = base64.b64decode(secrets["nonce"])
        data = base64.b64decode(secrets["data"])
        iterations = int(secrets.get("iterations") or ITERATIONS)
    except (KeyError, ValueError, TypeError) as e:
        raise BackupError("Повреждённый блок секретов.") from e
    if not 1 <= iterations <= 10_000_000 or len(nonce) != 12 or len(data) < 16:
        raise BackupError("Повреждённый блок секретов.")
    key = _derive(password, salt, iterations)
    try:
        plain = AESGCM(key).decrypt(nonce, data, None)
    except InvalidTag as e:
        raise BackupError("Неверный пароль резервной копии.") from e
    try:
        result = json.loads(plain.decode("utf-8"))
    except ValueError as e:
        raise BackupError("Повреждённый блок секретов.") from e
    return result if isinstance(result, dict) else {}


def export_backup(store: Store, path: str, include_secrets: bool = False, password: Optional[str] = None) -> None:
    data = {
        "format": FORMAT,
        "version": VERSION,
        "createdAt": now_iso(),
        "app": "linux",
        "hosts": [_drop_nulls(s.to_json()) for s in store.servers],
        "keys": [_drop_nulls(k.to_json()) for k in store.keys],
        "snippets": [_drop_nulls(s.to_json()) for s in store.snippets],
        "knownHosts": dict(store.known_hosts),
        "secrets": None,
    }
    if include_secrets:
        if not password:
            raise BackupError("Для сохранения паролей и ключей нужен пароль резервной копии.")
        secrets = {"passwords": {}, "proxyPasswords": {}, "privateKeys": {}, "passphrases": {}}
        for s in store.servers:
            pw = store.password(s)
            if pw:
                secrets["passwords"][s.id] = pw
            ppw = store.proxy_password(s)
            if ppw:
                secrets["proxyPasswords"][s.id] = ppw
        for k in store.keys:
            pem = store.private_key(k.id)
            if pem:
                secrets["privateKeys"][k.id] = pem
            pp = store.passphrase(k.id)
            if pp:
                secrets["passphrases"][k.id] = pp
        data["secrets"] = _encrypt(secrets, password)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def read_backup(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise BackupError(f"Не удалось прочитать файл: {e}") from e
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise BackupError("Это не резервная копия Termuxx.")
    if int(data.get("version") or 0) > VERSION:
        raise BackupError("Файл создан более новой версией Termuxx — обновите приложение.")
    return data


def has_secrets(data: dict) -> bool:
    return isinstance(data.get("secrets"), dict)


def import_backup(store: Store, data: dict, password: Optional[str] = None) -> ImportSummary:
    summary = ImportSummary()
    secrets = {}
    if has_secrets(data):
        if password:
            secrets = _decrypt(data["secrets"], password)
        else:
            summary.secrets_skipped = True

    def merge(items: list, new_items: list, on_replace=None) -> int:
        count = 0
        for item in new_items:
            for i, old in enumerate(items):
                if old.id == item.id:
                    if on_replace:
                        on_replace(old, item)
                    items[i] = item
                    break
            else:
                items.append(item)
            count += 1
        return count

    def keep_latest(old: Server, new: Server) -> None:
        # lastConnected — более поздний из двух
        if old.last_connected and (not new.last_connected or old.last_connected > new.last_connected):
            new.last_connected = old.last_connected

    def parse(items, factory, valid):
        result = []
        for d in items or []:
            if not isinstance(d, dict) or not d.get("id"):
                continue
            try:
                obj = factory(d)
            except (TypeError, ValueError, AttributeError):
                continue
            if valid(obj):
                result.append(obj)
        return result

    def valid_server(s: Server) -> bool:
        if not s.hostname:
            return False
        s.forwards = [f for f in s.forwards if 1 <= f.local_port <= 65535 and 1 <= f.remote_port <= 65535]
        return True

    servers = parse(data.get("hosts"), Server.from_json, valid_server)
    keys = parse(data.get("keys"), KeyItem.from_json, lambda k: True)
    snippets = parse(data.get("snippets"), Snippet.from_json, lambda sn: bool(sn.command))
    summary.servers = merge(store.servers, servers, keep_latest)
    summary.keys = merge(store.keys, keys)
    summary.snippets = merge(store.snippets, snippets)
    kh = data.get("knownHosts")
    if isinstance(kh, dict):
        for k, v in kh.items():
            store.known_hosts.setdefault(str(k), str(v))  # существующие отпечатки не перезаписываем

    def norm(d) -> dict:
        return {norm_id(k): v for k, v in (d or {}).items() if isinstance(v, str) and v} if isinstance(d, dict) else {}

    for sid, pw in norm(secrets.get("passwords")).items():
        server = store.server(sid)
        if server:
            store.set_password(server, pw)
            summary.secrets += 1
    for sid, pw in norm(secrets.get("proxyPasswords")).items():
        server = store.server(sid)
        if server:
            store.set_proxy_password(server, pw)
            summary.secrets += 1
    for kid, pem in norm(secrets.get("privateKeys")).items():
        if store.key(kid):
            store._set_secret(f"key.{kid}", pem)
            summary.secrets += 1
    for kid, pp in norm(secrets.get("passphrases")).items():
        if store.key(kid):
            store.set_passphrase(kid, pp)
            summary.secrets += 1
    store.save()
    return summary
