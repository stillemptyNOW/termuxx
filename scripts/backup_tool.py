#!/usr/bin/env python3
"""Termuxx backup tool — эталонная реализация формата резервной копии.

Формат описан в docs/BACKUP_FORMAT.md. Скрипт нужен, чтобы:
  * посмотреть, что внутри бэкапа (inspect);
  * расшифровать секции с паролями и ключами (decrypt);
  * сделать корректный зашифрованный пример для тестов (make-sample);
  * проверить, что криптография совпадает с iOS/Linux (selftest, test-vector).

Зависимости: python3, пакет `cryptography` (AES-GCM). PBKDF2 — из hashlib.

Примеры:
  python3 scripts/backup_tool.py inspect backup.termuxx
  python3 scripts/backup_tool.py decrypt backup.termuxx --password 'секрет'
  python3 scripts/backup_tool.py make-sample sample.termuxx --password 'termuxx-test'
  python3 scripts/backup_tool.py selftest
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import getpass
import hashlib
import json
import os
import sys
import tempfile
import unicodedata
import uuid

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
except ImportError:  # pragma: no cover
    AESGCM = None
    InvalidTag = Exception

# --- Параметры формата (должны совпадать с Termuxx/Backup/Backup.swift) -------------

FORMAT = "termuxx-backup"
VERSION = 1
FILE_EXTENSION = ".termuxx"
KDF = "pbkdf2-sha256"
CIPHER = "aes-256-gcm"
ITERATIONS = 200_000
SALT_LEN = 16
NONCE_LEN = 12
KEY_LEN = 32
TAG_LEN = 16

SECRET_SECTIONS = ("passwords", "proxyPasswords", "privateKeys", "passphrases")

# Тестовый вектор (детерминированный, для сверки реализаций).
TV_PASSWORD = "termuxx-test"
TV_SALT = bytes(range(16))          # 00 01 02 … 0f
TV_NONCE = bytes(range(12))         # 00 01 02 … 0b
TV_PLAINTEXT = b'{"passwords":{"00000000-0000-0000-0000-000000000001":"hunter2"}}'
TV_KEY_HEX = "2129619e41dd3db751840f201078659167570c36cd46d61729ac77c989895c82"
TV_DATA_B64 = "765Deq+mkx96CmNtWWzFo65I3QZFid4b+U+8wuuxysdBLEHj1artwfwkmWtUtcboB5PsYPBWTaOzFIbaNyCK4cziOYU2q9wNTACUgE2mHJM="


class BackupError(Exception):
    pass


class WrongPassword(BackupError):
    pass


# --- Криптография --------------------------------------------------------------------

def normalize_password(password: str) -> bytes:
    """Пароль → байты: Unicode NFC, затем UTF-8 (так же делает iOS)."""
    return unicodedata.normalize("NFC", password).encode("utf-8")


def derive_key(password: str, salt: bytes, iterations: int = ITERATIONS) -> bytes:
    if not password:
        raise BackupError("пустой пароль")
    return hashlib.pbkdf2_hmac("sha256", normalize_password(password), salt, iterations, dklen=KEY_LEN)


def _require_aesgcm():
    if AESGCM is None:
        sys.exit("Нужен пакет cryptography: pip install cryptography")


def seal(plaintext: bytes, password: str, *, iterations: int = ITERATIONS,
         salt: bytes | None = None, nonce: bytes | None = None) -> dict:
    """Шифрует JSON с секретами и возвращает объект для поля "secrets"."""
    _require_aesgcm()
    salt = salt if salt is not None else os.urandom(SALT_LEN)
    nonce = nonce if nonce is not None else os.urandom(NONCE_LEN)
    key = derive_key(password, salt, iterations)
    data = AESGCM(key).encrypt(nonce, plaintext, None)  # ciphertext || tag(16), без AAD
    return {
        "kdf": KDF,
        "iterations": iterations,
        "salt": base64.b64encode(salt).decode(),
        "cipher": CIPHER,
        "nonce": base64.b64encode(nonce).decode(),
        "data": base64.b64encode(data).decode(),
    }


def open_secrets(envelope: dict, password: str) -> bytes:
    _require_aesgcm()
    if str(envelope.get("kdf", "")).lower() != KDF:
        raise BackupError(f"неизвестный KDF: {envelope.get('kdf')}")
    if str(envelope.get("cipher", "")).lower() != CIPHER:
        raise BackupError(f"неизвестный шифр: {envelope.get('cipher')}")
    iterations = int(envelope.get("iterations", 0))
    if not 1 <= iterations <= 10_000_000:
        raise BackupError("неверное число итераций")
    salt = base64.b64decode(envelope["salt"])
    nonce = base64.b64decode(envelope["nonce"])
    data = base64.b64decode(envelope["data"])
    if len(nonce) != NONCE_LEN or len(data) < TAG_LEN or not salt:
        raise BackupError("повреждена секция secrets")
    key = derive_key(password, salt, iterations)
    try:
        return AESGCM(key).decrypt(nonce, data, None)
    except InvalidTag as exc:
        raise WrongPassword("неверный пароль бэкапа") from exc


# --- Работа с файлом -------------------------------------------------------------------

def iso_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id() -> str:
    return str(uuid.uuid4()).upper()


def load(path: str) -> dict:
    with open(path, "rb") as fh:
        doc = json.load(fh)
    if not isinstance(doc, dict) or doc.get("format") != FORMAT:
        raise BackupError("это не файл резервной копии Termuxx")
    if int(doc.get("version", 1)) > VERSION:
        raise BackupError(f"бэкап новее, чем поддерживает скрипт (version={doc.get('version')})")
    return doc


def dump(doc: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def build_backup(*, hosts, keys, snippets, known_hosts, secrets: dict | None,
                 password: str | None, app: str = "linux") -> dict:
    envelope = None
    if secrets is not None and any(secrets.get(s) for s in SECRET_SECTIONS):
        if not password:
            raise BackupError("для секретов нужен пароль")
        payload = {s: {k.upper(): v for k, v in (secrets.get(s) or {}).items()} for s in SECRET_SECTIONS}
        plaintext = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        envelope = seal(plaintext, password)
    return {
        "format": FORMAT,
        "version": VERSION,
        "app": app,
        "createdAt": iso_now(),
        "hosts": hosts,
        "keys": keys,
        "snippets": snippets,
        "knownHosts": known_hosts,
        "secrets": envelope,
    }


def _ask_password(prompt: str = "Пароль бэкапа: ") -> str:
    return getpass.getpass(prompt)


# --- Команды -------------------------------------------------------------------------

def cmd_inspect(args) -> int:
    doc = load(args.file)
    print(f"Файл:        {args.file}")
    print(f"Источник:    {doc.get('app', '?')}  (формат {doc.get('version')})")
    print(f"Создан:      {doc.get('createdAt', '?')}")
    print(f"Серверов:    {len(doc.get('hosts') or [])}")
    print(f"Ключей:      {len(doc.get('keys') or [])}")
    print(f"Сниппетов:   {len(doc.get('snippets') or [])}")
    print(f"Отпечатков:  {len(doc.get('knownHosts') or {})}")
    sec = doc.get("secrets")
    if sec:
        print(f"Секреты:     зашифрованы ({sec.get('cipher')}, {sec.get('kdf')} × {sec.get('iterations')})")
    else:
        print("Секреты:     нет")
    for h in doc.get("hosts") or []:
        print(f"  • {h.get('name') or h.get('hostname')}  {h.get('username')}@{h.get('hostname')}:{h.get('port')}  [{h.get('auth')}]")
    return 0


def cmd_decrypt(args) -> int:
    doc = load(args.file)
    sec = doc.get("secrets")
    if not sec:
        print("В бэкапе нет зашифрованных секретов.")
        return 0
    password = args.password if args.password is not None else _ask_password()
    try:
        plaintext = open_secrets(sec, password)
    except WrongPassword as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(json.loads(plaintext), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def make_sample(password: str) -> dict:
    """Корректный бэкап с одним сервером, одним ключом Ed25519 и сниппетом."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    priv = ed25519.Ed25519PrivateKey.generate()
    pem = priv.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.OpenSSH,
        serialization.NoEncryption(),
    ).decode()
    pub = priv.public_key().public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
    ).decode() + " sample"

    host_pw_id, host_key_id, key_id, snippet_id = new_id(), new_id(), new_id(), new_id()
    now = iso_now()
    hosts = [
        {
            "id": host_pw_id, "name": "Finland VPS", "hostname": "203.0.113.10", "port": 22,
            "username": "root", "auth": "password", "colorHex": "#3DDC97", "lastConnected": now,
            "useTmux": True, "autoReconnect": True, "keepAlive": True,
            "forwards": [{"id": new_id(), "name": "Панель", "localPort": 8080,
                          "remoteHost": "127.0.0.1", "remotePort": 80, "autoStart": True}],
        },
        {
            "id": host_key_id, "name": "Через прокси", "hostname": "198.51.100.7", "port": 2222,
            "username": "admin", "auth": "key", "keyID": key_id, "startupSnippetID": snippet_id,
            "colorHex": "#4EA8FF", "useTmux": False, "autoReconnect": True, "keepAlive": True,
            "jumpHostID": host_pw_id,
            "proxy": {"host": "127.0.0.1", "port": 1080, "username": "proxyuser"},
            "forwards": [],
        },
    ]
    keys = [{"id": key_id, "name": "sample", "type": "ED25519", "publicKey": pub,
             "created": now, "encrypted": False}]
    snippets = [{"id": snippet_id, "name": "Место на диске", "command": "df -h", "runImmediately": True}]
    known = {"203.0.113.10:22": "ssh-ed25519 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
    secrets = {
        "passwords": {host_pw_id: "hunter2"},
        "proxyPasswords": {host_key_id: "proxy-pass"},
        "privateKeys": {key_id: pem},
        "passphrases": {},
    }
    return build_backup(hosts=hosts, keys=keys, snippets=snippets, known_hosts=known,
                        secrets=secrets, password=password, app="linux")


def cmd_make_sample(args) -> int:
    password = args.password if args.password is not None else _ask_password("Новый пароль бэкапа: ")
    doc = make_sample(password)
    dump(doc, args.out)
    print(f"Готово: {args.out}")
    return 0


def test_vector() -> tuple[str, str]:
    key = derive_key(TV_PASSWORD, TV_SALT, ITERATIONS)
    env = seal(TV_PLAINTEXT, TV_PASSWORD, salt=TV_SALT, nonce=TV_NONCE)
    return key.hex(), env["data"]


def cmd_test_vector(_args) -> int:
    key_hex, data_b64 = test_vector()
    print("password  :", TV_PASSWORD)
    print("salt      :", TV_SALT.hex())
    print("nonce     :", TV_NONCE.hex())
    print("iterations:", ITERATIONS)
    print("plaintext :", TV_PLAINTEXT.decode())
    print("key (hex) :", key_hex)
    print("data (b64):", data_b64)
    return 0


def cmd_selftest(_args) -> int:
    _require_aesgcm()
    # 1. Тестовый вектор.
    key_hex, data_b64 = test_vector()
    assert key_hex == TV_KEY_HEX, f"KDF не совпал: {key_hex}"
    assert data_b64 == TV_DATA_B64, f"AES-GCM не совпал: {data_b64}"
    env = {"kdf": KDF, "iterations": ITERATIONS, "salt": base64.b64encode(TV_SALT).decode(),
           "cipher": CIPHER, "nonce": base64.b64encode(TV_NONCE).decode(), "data": TV_DATA_B64}
    assert open_secrets(env, TV_PASSWORD) == TV_PLAINTEXT
    # 2. Нормализация Unicode: «й» составной и разложенный дают один ключ.
    assert derive_key("й", TV_SALT, 1000) == derive_key("й", TV_SALT, 1000)
    # 3. Полный файл: создать → прочитать → расшифровать; неверный пароль → ошибка.
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sample" + FILE_EXTENSION)
        dump(make_sample("пароль-123"), path)
        doc = load(path)
        assert doc["format"] == FORMAT and doc["version"] == VERSION
        assert doc["createdAt"].endswith("Z") and "." not in doc["createdAt"]
        secrets = json.loads(open_secrets(doc["secrets"], "пароль-123"))
        assert set(secrets) == set(SECRET_SECTIONS)
        host_ids = {h["id"] for h in doc["hosts"]}
        assert set(secrets["passwords"]) <= host_ids
        assert all(i == i.upper() for i in host_ids)
        assert next(iter(secrets["privateKeys"].values())).startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
        try:
            open_secrets(doc["secrets"], "wrong")
        except WrongPassword:
            pass
        else:
            raise AssertionError("неверный пароль не обнаружен")
    print("selftest: OK")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Termuxx backup tool")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("inspect", help="показать содержимое бэкапа")
    p.add_argument("file")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("decrypt", help="расшифровать пароли и ключи")
    p.add_argument("file")
    p.add_argument("--password")
    p.set_defaults(func=cmd_decrypt)

    p = sub.add_parser("make-sample", help="создать пример зашифрованного бэкапа")
    p.add_argument("out")
    p.add_argument("--password")
    p.set_defaults(func=cmd_make_sample)

    p = sub.add_parser("test-vector", help="напечатать тестовый вектор")
    p.set_defaults(func=cmd_test_vector)

    p = sub.add_parser("selftest", help="проверить криптографию и формат")
    p.set_defaults(func=cmd_selftest)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except BackupError as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
