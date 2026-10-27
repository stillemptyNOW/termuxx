"""Сборка командной строки системного `ssh` для сервера из хранилища.

Терминальные вкладки используют настоящий OpenSSH: он сам спрашивает пароль/ключ сервера
прямо в терминале и поддерживает всё (агент, ~/.ssh/config, ProxyJump и т.д.).
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Optional

from termuxx.store import DATA_DIR, Server, Store

KEEPALIVE_OPTS = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"]


@dataclass
class SSHCommand:
    argv: list
    env: dict = field(default_factory=dict)
    temp_files: list = field(default_factory=list)
    uses_sshpass: bool = False

    def cleanup(self) -> None:
        for path in self.temp_files:
            try:
                os.remove(path)
            except OSError:
                pass
        self.temp_files.clear()

    def display(self) -> str:
        return " ".join(shlex.quote(a) for a in self.argv)


def which(name: str) -> Optional[str]:
    return shutil.which(name)


def host_is_known(hostname: str, port: int) -> bool:
    """Есть ли ключ сервера в ~/.ssh/known_hosts (учитывает хэшированные записи)."""
    if not which("ssh-keygen"):
        return True
    name = hostname if port == 22 else f"[{hostname}]:{port}"
    try:
        r = subprocess.run(["ssh-keygen", "-F", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return True


def _secret_file(secret: str) -> str:
    """Временный файл 0600 с паролем для `sshpass -f` (удаляется после подключения)."""
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    base = runtime if runtime and os.path.isdir(runtime) else os.path.join(DATA_DIR, "run")
    os.makedirs(base, mode=0o700, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix="termuxx-", dir=base)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(secret)
    return path


def _proxy_command(store: Store, server: Server, cmd: SSHCommand) -> Optional[str]:
    proxy = server.proxy
    if not proxy or not proxy.host:
        return None
    if proxy.username and which("ncat"):
        auth = f"{proxy.username}:{store.proxy_password(server) or ''}"
        return (
            f"ncat --proxy-type socks5 --proxy {shlex.quote(f'{proxy.host}:{proxy.port}')} "
            f"--proxy-auth {shlex.quote(auth)} %h %p"
        )
    if which("nc"):
        return f"nc -X 5 -x {shlex.quote(f'{proxy.host}:{proxy.port}')} %h %p"
    if which("ncat"):
        return f"ncat --proxy-type socks5 --proxy {shlex.quote(f'{proxy.host}:{proxy.port}')} %h %p"
    return None


def _jump_proxy_command(store: Store, jump: Server, cmd: SSHCommand) -> Optional[str]:
    """ProxyCommand через промежуточный сервер. Возвращает None, если хватает обычного -J."""
    parts: list[str] = []
    if jump.auth == "password":
        pw = store.password(jump)
        if not pw or not which("sshpass"):
            return None  # пусть ssh спросит пароль промежуточного сервера сам (через -J)
        path = _secret_file(pw)
        cmd.temp_files.append(path)
        parts += ["sshpass", "-f", path]
    parts += ["ssh", "-p", str(jump.port)]
    if jump.keep_alive:
        parts += KEEPALIVE_OPTS
    if jump.auth == "key" and jump.key_id:
        key_file = store.key_file(jump.key_id)
        if key_file:
            parts += ["-i", key_file, "-o", "IdentitiesOnly=yes"]
            if store.passphrase(jump.key_id):
                # ssh-agent / sshpass не могут ввести passphrase внутри ProxyCommand — отдаём на откуп -J.
                return None
    parts += ["-W", "%h:%p", f"{jump.username}@{jump.hostname}"]
    return " ".join(shlex.quote(p) if p not in ("%h:%p",) else p for p in parts)


def remote_command(store: Store, server: Server) -> Optional[str]:
    snippet = store.snippet(server.startup_snippet_id) if server.startup_snippet_id else None
    snippet_cmd = snippet.command.strip() if snippet and snippet.command.strip() else None
    if server.use_tmux:
        if snippet_cmd:
            inner = f"{snippet_cmd}; exec \"$SHELL\" -l"
            new = f"tmux new-session -s termuxx {shlex.quote(inner)}"
        else:
            new = "tmux new-session -s termuxx"
        return (
            "if command -v tmux >/dev/null 2>&1; then "
            "tmux has-session -t termuxx 2>/dev/null && exec tmux attach-session -t termuxx || exec " + new + "; "
            "else echo 'tmux не установлен на сервере'; exec \"$SHELL\" -l; fi"
        )
    if snippet_cmd:
        return f"{snippet_cmd}; exec \"$SHELL\" -l"
    return None


def build(store: Store, server: Server, password: Optional[str] = None, with_forwards: bool = True,
          remote: Optional[str] = "auto") -> SSHCommand:
    """Команда для подключения к серверу в терминальной вкладке."""
    cmd = SSHCommand(argv=[])
    argv: list[str] = []

    secret = None
    prompt_flag: list[str] = []
    if server.auth == "password":
        secret = password or store.password(server)
    elif server.auth == "key" and server.key_id:
        secret = store.passphrase(server.key_id)
        if secret:
            prompt_flag = ["-P", "assphrase"]

    # sshpass не умеет отвечать на вопрос о новом ключе сервера — в первый раз пусть ssh спросит сам.
    if secret and which("sshpass") and host_is_known(server.hostname, server.port):
        argv += ["sshpass", *prompt_flag, "-e"]
        cmd.env["SSHPASS"] = secret
        cmd.uses_sshpass = True

    argv += ["ssh", "-p", str(server.port)]
    if server.keep_alive:
        argv += KEEPALIVE_OPTS
    if server.auth == "key" and server.key_id:
        key_file = store.key_file(server.key_id)
        if key_file:
            argv += ["-i", key_file, "-o", "IdentitiesOnly=yes"]
    elif server.auth == "password":
        argv += ["-o", "PreferredAuthentications=password,keyboard-interactive,publickey"]

    jump = store.server(server.jump_host_id) if server.jump_host_id else None
    if jump and jump.id != server.id:
        proxy_cmd = _jump_proxy_command(store, jump, cmd)
        if proxy_cmd:
            argv += ["-o", f"ProxyCommand={proxy_cmd}"]
        else:
            target = f"{jump.username}@{jump.hostname}" + (f":{jump.port}" if jump.port != 22 else "")
            argv += ["-J", target]
    else:
        proxy_cmd = _proxy_command(store, server, cmd)
        if proxy_cmd:
            argv += ["-o", f"ProxyCommand={proxy_cmd}"]

    if with_forwards:
        forwards = [f for f in server.forwards if f.auto_start]
        for f in forwards:
            argv += ["-L", f"127.0.0.1:{f.local_port}:{f.remote_host}:{f.remote_port}"]
        if forwards:
            argv += ["-o", "ExitOnForwardFailure=no"]

    rc = remote_command(store, server) if remote == "auto" else remote
    argv.append("-t" if rc else "-tt")
    argv.append(f"{server.username}@{server.hostname}")
    if rc:
        argv.append(rc)

    cmd.argv = argv
    return cmd


def copy_id_command(store: Store, server: Server, public_key_path: str) -> SSHCommand:
    """`ssh-copy-id` с теми же параметрами подключения (порт, jump, прокси)."""
    base = build(store, server, with_forwards=False, remote=None)
    argv: list[str] = []
    it = iter(base.argv)
    for a in it:
        if a == "ssh":
            argv += ["ssh-copy-id", "-f", "-i", public_key_path]
            continue
        if a in ("-t", "-tt"):
            continue
        if a == "-J":
            argv += ["-o", f"ProxyJump={next(it)}"]
            continue
        if a == "-i":  # у ssh-copy-id «-i» — это ключ, который нужно установить
            argv += ["-o", f"IdentityFile={next(it)}"]
            continue
        if a == "-p":
            argv += ["-p", next(it)]
            continue
        argv.append(a)
    base.argv = argv
    return base
