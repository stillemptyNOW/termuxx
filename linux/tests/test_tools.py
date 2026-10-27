"""Функциональные тесты сетевых модулей Termuxx против локального sshd.

Запуск (нужен sshd на 127.0.0.1:2222 с пользователем tester/secret123 и ключами из TERMUXX_TEST_KEYS):
    HOME=<временный дом> TERMUXX_TEST_KEYS=<папка с ключами> python3 -m pytest -q linux/tests/test_tools.py
или просто python3 linux/tests/test_tools.py
"""

from __future__ import annotations

import http.server
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from termuxx import monitor_window, sftp_window, sshconn, tunnels  # noqa: E402

KEYS = os.environ.get("TERMUXX_TEST_KEYS", "")
PORT = int(os.environ.get("TERMUXX_TEST_PORT", "2222"))


@dataclass
class Proxy:
    host: str
    port: int
    username: str = ""


@dataclass
class Forward:
    local_port: int
    remote_host: str
    remote_port: int
    id: str = "F1"
    name: str = ""
    auto_start: bool = True


@dataclass
class Srv:
    id: str
    hostname: str = "localhost"
    port: int = PORT
    username: str = "tester"
    auth: str = "password"
    key_id: Optional[str] = None
    jump_host_id: Optional[str] = None
    proxy: Optional[Proxy] = None
    keep_alive: bool = True
    use_tmux: bool = False
    forwards: list = field(default_factory=list)
    name: str = ""

    @property
    def title(self):
        return self.name or self.hostname

    @property
    def subtitle(self):
        return f"{self.username}@{self.hostname}:{self.port}"


class StubStore:
    def __init__(self):
        self.servers = []
        self.passwords = {}
        self.keys = {}
        self.passphrases = {}
        self.marked = []

    def server(self, sid):
        return next((s for s in self.servers if s.id == sid), None)

    def password(self, server):
        return self.passwords.get(server.id)

    def proxy_password(self, server):
        return None

    def private_key(self, key_id):
        return self.keys.get(key_id)

    def passphrase(self, key_id):
        return self.passphrases.get(key_id)

    def key_file(self, key_id):
        return None

    def mark_connected(self, server):
        self.marked.append(server.id)


def read(path):
    with open(path) as f:
        return f.read()


def make_store():
    st = StubStore()
    st.keys["plain"] = read(os.path.join(KEYS, "plain"))
    st.keys["enc"] = read(os.path.join(KEYS, "enc"))
    st.keys["rsa"] = read(os.path.join(KEYS, "rsa"))
    st.passphrases["enc"] = "pass123"
    return st


def connect_trusting(store, server, password=None):
    for _ in range(3):
        try:
            return sshconn.connect(store, server, password)
        except sshconn.UnknownHostKey as e:
            sshconn.trust_host_key(e)
    raise AssertionError("не удалось доверить ключ")


def test_unknown_then_trust_and_exec():
    if os.path.exists(sshconn.KNOWN_HOSTS):
        os.remove(sshconn.KNOWN_HOSTS)
    st = make_store()
    srv = Srv("A")
    st.servers.append(srv)
    st.passwords["A"] = "secret123"
    try:
        sshconn.connect(st, srv)
        raise AssertionError("ожидалась UnknownHostKey")
    except sshconn.UnknownHostKey as e:
        assert e.fingerprint.startswith("ssh-ed25519 SHA256:"), e.fingerprint
        assert e.port == PORT
        sshconn.trust_host_key(e)
    with open(sshconn.KNOWN_HOSTS) as f:
        assert f"[localhost]:{PORT} ssh-ed25519 " in f.read()
    conn = sshconn.connect(st, srv)
    code, out = conn.exec("echo привет; echo err >&2; exit 3")
    assert code == 3 and "привет" in out and "err" in out, (code, out)
    code, out = conn.run_script("x=5\necho $((x*2))\n")
    assert code == 0 and out.strip() == "10", out
    assert st.marked == ["A"]
    conn.close()


def test_wrong_password_and_missing_password():
    st = make_store()
    srv = Srv("A")
    st.servers.append(srv)
    try:
        sshconn.connect(st, srv)
        raise AssertionError("ожидалась NoPassword")
    except sshconn.NoPassword:
        pass
    try:
        connect_trusting(st, srv, password="nope")
        raise AssertionError("ожидалась AuthFailed")
    except sshconn.AuthFailed as e:
        assert "Неверный" in str(e), str(e)


def test_key_auth_variants():
    st = make_store()
    for key_id in ("plain", "enc", "rsa"):
        srv = Srv("K", auth="key", key_id=key_id)
        conn = connect_trusting(st, srv)
        assert conn.exec("whoami")[1].strip() == "tester"
        conn.close()
    st.passphrases["enc"] = "wrong"
    try:
        connect_trusting(st, Srv("K", auth="key", key_id="enc"))
        raise AssertionError("ожидалась ошибка пароля ключа")
    except sshconn.AuthFailed as e:
        assert "пароль" in str(e).lower(), str(e)
    st.passphrases.pop("enc")
    try:
        connect_trusting(st, Srv("K", auth="key", key_id="enc"))
        raise AssertionError("ожидалась ошибка: нужен пароль ключа")
    except sshconn.AuthFailed as e:
        assert "passphrase" in str(e).lower() or "пароль" in str(e).lower(), str(e)


def test_host_key_changed():
    st = make_store()
    st.passwords["A"] = "secret123"
    srv = Srv("A", hostname="127.0.0.1")
    connect_trusting(st, srv).close()
    # Подменяем ключ в known_hosts
    alt = read(os.path.join(os.path.dirname(KEYS.rstrip("/")), "sshd", "hostkey_alt.pub")).split()
    lines = []
    for line in read(sshconn.KNOWN_HOSTS).splitlines():
        if line.startswith(f"[127.0.0.1]:{PORT} "):
            line = f"[127.0.0.1]:{PORT} {alt[0]} {alt[1]}"
        lines.append(line)
    with open(sshconn.KNOWN_HOSTS, "w") as f:
        f.write("\n".join(lines) + "\n")
    try:
        sshconn.connect(st, srv)
        raise AssertionError("ожидалась HostKeyChanged")
    except sshconn.HostKeyChanged as e:
        assert "изменился" in str(e)
    # Возвращаем правильную запись
    with open(sshconn.KNOWN_HOSTS, "w") as f:
        f.write("\n".join(l for l in lines if not l.startswith(f"[127.0.0.1]:{PORT} ")) + "\n")


def test_jump_host():
    st = make_store()
    jump = Srv("J", hostname="localhost")
    st.passwords["J"] = "secret123"
    target = Srv("T", hostname="127.0.0.1", auth="key", key_id="plain", jump_host_id="J")
    st.servers += [jump, target]
    conn = connect_trusting(st, target)
    assert conn.jump is not None
    assert conn.exec("echo jumped")[1].strip() == "jumped"
    conn.close()
    assert not conn.jump.is_active


def test_socks5_proxy():
    key = os.path.join(KEYS, "plain")
    port = 1085
    proc = subprocess.Popen(
        ["ssh", "-N", "-D", f"127.0.0.1:{port}", "-i", key, "-p", str(PORT),
         "-o", "StrictHostKeyChecking=no", "-o", f"UserKnownHostsFile={os.devnull}",
         "-o", "BatchMode=yes", "tester@127.0.0.1"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        st = make_store()
        srv = Srv("P", hostname="localhost", auth="key", key_id="plain", proxy=Proxy("127.0.0.1", port))
        conn = connect_trusting(st, srv)
        assert conn.exec("echo via-socks")[1].strip() == "via-socks"
        conn.close()
        # Встроенный клиент SOCKS5 без PySocks
        saved = sys.modules.get("socks")
        sys.modules["socks"] = None  # import socks -> ImportError
        try:
            conn = connect_trusting(st, srv)
            assert conn.exec("echo builtin-socks")[1].strip() == "builtin-socks"
            conn.close()
        finally:
            if saved is not None:
                sys.modules["socks"] = saved
            else:
                sys.modules.pop("socks", None)
    finally:
        proc.terminate()
        proc.wait()


def test_metrics_and_services_parsing():
    st = make_store()
    conn = connect_trusting(st, Srv("K", auth="key", key_id="plain"))
    _code, out = conn.run_script(monitor_window.METRICS_SCRIPT)
    snap = monitor_window.parse_metrics(out)
    assert snap.hostname, out
    assert snap.cpu_total > 0 and snap.mem_total > 0, out
    assert snap.cores >= 1 and snap.uptime > 0
    assert snap.procs, out
    time.sleep(1.1)
    snap2 = monitor_window.parse_metrics(conn.run_script(monitor_window.METRICS_SCRIPT)[1])
    assert snap2.cpu_total >= snap.cpu_total
    _code, out = conn.run_script(monitor_window.SERVICES_SCRIPT)
    services, containers = monitor_window.parse_services(out)
    assert services is None or isinstance(services, list)
    assert isinstance(containers, list)
    conn.close()

    sample = """@@SVC
  cron.service      loaded active   running Regular background program processing daemon
● nginx.service     loaded failed   failed  A high performance web server
  ssh.service       loaded active   running OpenBSD Secure Shell server
  foo.service       not-found inactive dead foo.service
@@DOCKER
web|running|Up 2 hours|nginx:latest
db|exited|Exited (0) 3 days ago|postgres:16
@@END
"""
    services, containers = monitor_window.parse_services(sample)
    assert [s.name for s in services] == ["cron", "nginx", "ssh", "foo"], services
    assert services[1].active == "failed"
    assert [c.name for c in containers] == ["web", "db"]


def test_sftp_transfers_and_cancel():
    st = make_store()
    conn = connect_trusting(st, Srv("K", auth="key", key_id="plain"))
    sftp = conn.open_sftp()
    home = sftp.normalize(".")
    tmp = tempfile.mkdtemp()
    try:
        src = os.path.join(tmp, "src")
        os.makedirs(os.path.join(src, "sub"))
        payload = os.urandom(3 * 1024 * 1024 + 123)
        with open(os.path.join(src, "big.bin"), "wb") as f:
            f.write(payload)
        with open(os.path.join(src, "sub", "note.txt"), "w") as f:
            f.write("заметка")
        remote_dir = home + "/termuxx-test"
        try:
            sftp_window._rm_rf(sftp, remote_dir)
        except IOError:
            pass
        sftp.mkdir(remote_dir)
        job = sftp_window.TransferJob("upload", "up", [src], remote_dir)
        sftp_window._run_upload(sftp, job)
        assert job.files_total == 2 and job.done == job.total == len(payload) + len("заметка".encode())
        assert sftp.stat(remote_dir + "/src/big.bin").st_size == len(payload)

        class Item:
            def __init__(self, name, path):
                self.name, self.path = name, path

        out_dir = os.path.join(tmp, "out")
        os.makedirs(out_dir)
        job = sftp_window.TransferJob("download", "down", [Item("src", remote_dir + "/src")], out_dir)
        sftp_window._run_download(sftp, job)
        with open(os.path.join(out_dir, "src", "big.bin"), "rb") as f:
            assert f.read() == payload
        with open(os.path.join(out_dir, "src", "sub", "note.txt")) as f:
            assert f.read() == "заметка"
        # повторное скачивание не перезаписывает, а создаёт «src (1)»
        job = sftp_window.TransferJob("download", "down", [Item("src", remote_dir + "/src")], out_dir)
        sftp_window._run_download(sftp, job)
        assert os.path.isdir(os.path.join(out_dir, "src (1)"))

        # отмена
        job = sftp_window.TransferJob("upload", "up", [os.path.join(src, "big.bin")], remote_dir)

        def cancel_soon():
            while job.done == 0:
                time.sleep(0.001)
            job.cancelled = True

        threading.Thread(target=cancel_soon, daemon=True).start()
        try:
            sftp_window._run_upload(sftp, job)
            cancelled = False
        except sftp_window.Cancelled:
            cancelled = True
        if cancelled:
            try:
                sftp.stat(remote_dir + "/big.bin")
                raise AssertionError("частичный файл должен быть удалён")
            except FileNotFoundError:
                pass
        sftp_window._rm_rf(sftp, remote_dir)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        sftp.close()
        conn.close()


def test_tunnel_forwarding():
    root = tempfile.mkdtemp()
    with open(os.path.join(root, "hello.txt"), "w") as f:
        f.write("hello through tunnel")
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=root, **kw)  # noqa: E731
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    http_port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    st = make_store()
    srv = Srv("K", auth="key", key_id="plain")
    st.servers.append(srv)
    connect_trusting(st, srv).close()
    mgr = tunnels.TunnelManager.get(st)
    events = []
    mgr.subscribe(lambda: events.append(1))
    fw = Forward(18089, "127.0.0.1", http_port, id="FW1")
    mgr.start(srv, fw)
    for _ in range(100):
        if mgr.status("FW1") and mgr.status("FW1").state in ("active", "error"):
            break
        time.sleep(0.05)
    assert mgr.status("FW1").state == "active", mgr.status("FW1")
    body = urllib.request.urlopen("http://127.0.0.1:18089/hello.txt", timeout=10).read().decode()
    assert body == "hello through tunnel", body
    # несколько параллельных запросов
    results = []

    def fetch():
        results.append(urllib.request.urlopen("http://127.0.0.1:18089/hello.txt", timeout=10).read())

    threads = [threading.Thread(target=fetch) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(results) == 8 and all(r == b"hello through tunnel" for r in results)
    assert mgr.status("FW1").total_connections >= 9
    assert mgr.is_active("FW1") and len(mgr.active()) == 1
    # занятый порт → ошибка
    fw2 = Forward(18089, "127.0.0.1", http_port, id="FW2")
    mgr.start(srv, fw2)
    for _ in range(100):
        if mgr.status("FW2").state in ("active", "error"):
            break
        time.sleep(0.05)
    assert mgr.status("FW2").state == "error" and "занят" in mgr.status("FW2").error, mgr.status("FW2")
    mgr.stop("FW1")
    assert not mgr.is_active("FW1")
    time.sleep(0.6)
    try:
        socket.create_connection(("127.0.0.1", 18089), timeout=0.5).close()
        raise AssertionError("порт должен быть закрыт")
    except OSError:
        pass
    assert "K" not in mgr._conns
    httpd.shutdown()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    order = ["test_unknown_then_trust_and_exec"]
    tests.sort(key=lambda t: (t.__name__ not in order, t.__name__))
    failed = 0
    for t in tests:
        start = time.time()
        try:
            t()
            print(f"OK   {t.__name__} ({time.time() - start:.1f}s)")
        except Exception as e:  # noqa: BLE001
            failed += 1
            import traceback

            traceback.print_exc()
            print(f"FAIL {t.__name__}: {e}")
    print("failed:", failed)
    sys.exit(1 if failed else 0)
