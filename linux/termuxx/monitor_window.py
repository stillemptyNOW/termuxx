"""Мониторинг сервера для Termuxx: процессор, память, диски, сеть, процессы, сервисы и Docker."""

from __future__ import annotations

import shlex
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, GLib, Gtk, Pango  # noqa: E402

from . import sshconn  # noqa: E402
from .sshconn import describe_error, run_in_thread  # noqa: E402

POLL_SECONDS = 3
SERVICES_EVERY = 30
HISTORY = 60

ACCENT = (0x3D / 255, 0xDC / 255, 0x97 / 255)
BLUE = (0x4E / 255, 0xA8 / 255, 0xFF / 255)

METRICS_SCRIPT = r"""
LC_ALL=C; export LC_ALL
echo "@@HOST"; hostname 2>/dev/null || cat /etc/hostname 2>/dev/null
echo "@@OS"; ( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-$(uname -s)}" ); uname -r
echo "@@UPTIME"; cat /proc/uptime
echo "@@LOAD"; cat /proc/loadavg
echo "@@NPROC"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo "@@STAT"; head -n 1 /proc/stat
echo "@@MEM"; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
echo "@@DISK"; { df -kP -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null || df -kP 2>/dev/null; } | tail -n +2
echo "@@NET"; tail -n +3 /proc/net/dev
echo "@@PROC"; ps -eo pid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -n 9
echo "@@END"
"""

SERVICES_SCRIPT = r"""
LC_ALL=C; export LC_ALL
echo "@@SVC"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null
else
  echo "@@NOSYSTEMD"
fi
echo "@@DOCKER"
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}' 2>/dev/null
fi
echo "@@END"
"""


# ---------------------------------------------------------------------------
# Разбор вывода
# ---------------------------------------------------------------------------


@dataclass
class Disk:
    mount: str
    size_kb: int
    used_kb: int

    @property
    def fraction(self) -> float:
        return self.used_kb / self.size_kb if self.size_kb else 0.0


@dataclass
class Proc:
    pid: str
    name: str
    cpu: float
    mem: float


@dataclass
class Snapshot:
    hostname: str = ""
    os_name: str = ""
    kernel: str = ""
    uptime: float = 0.0
    load: tuple = (0.0, 0.0, 0.0)
    cores: int = 1
    cpu_total: int = 0
    cpu_idle: int = 0
    mem_total: int = 0
    mem_available: int = 0
    swap_total: int = 0
    swap_free: int = 0
    disks: list = field(default_factory=list)
    net_rx: int = 0
    net_tx: int = 0
    procs: list = field(default_factory=list)
    taken: float = 0.0


@dataclass
class Service:
    unit: str
    load: str
    active: str
    sub: str
    description: str

    @property
    def name(self) -> str:
        return self.unit[:-8] if self.unit.endswith(".service") else self.unit


@dataclass
class Container:
    name: str
    state: str
    status: str
    image: str


def _sections(text: str) -> dict:
    sections: dict[str, list[str]] = {}
    current = None
    for line in text.splitlines():
        if line.startswith("@@"):
            current = line[2:].strip()
            sections.setdefault(current, [])
            continue
        if current is not None:
            sections[current].append(line)
    return sections


def parse_metrics(text: str) -> Snapshot:
    s = _sections(text)
    snap = Snapshot(taken=time.monotonic())
    host = [l for l in s.get("HOST", []) if l.strip()]
    snap.hostname = host[0].strip() if host else ""
    os_lines = [l for l in s.get("OS", []) if l.strip()]
    if os_lines:
        snap.os_name = os_lines[0].strip()
    if len(os_lines) > 1:
        snap.kernel = os_lines[1].strip()
    try:
        snap.uptime = float(s.get("UPTIME", ["0"])[0].split()[0])
    except (ValueError, IndexError):
        pass
    try:
        parts = s.get("LOAD", [""])[0].split()
        snap.load = (float(parts[0]), float(parts[1]), float(parts[2]))
    except (ValueError, IndexError):
        pass
    try:
        snap.cores = max(1, int(s.get("NPROC", ["1"])[0].strip()))
    except (ValueError, IndexError):
        pass
    try:
        fields = s.get("STAT", [""])[0].split()
        if fields and fields[0] == "cpu":
            nums = [int(x) for x in fields[1:9]]
            while len(nums) < 8:
                nums.append(0)
            snap.cpu_total = sum(nums)
            snap.cpu_idle = nums[3] + nums[4]
    except ValueError:
        pass
    for line in s.get("MEM", []):
        parts = line.replace(":", " ").split()
        if len(parts) < 2:
            continue
        try:
            value = int(parts[1])
        except ValueError:
            continue
        key = parts[0]
        if key == "MemTotal":
            snap.mem_total = value
        elif key == "MemAvailable":
            snap.mem_available = value
        elif key == "SwapTotal":
            snap.swap_total = value
        elif key == "SwapFree":
            snap.swap_free = value
    seen = set()
    for line in s.get("DISK", []):
        parts = line.split()
        if len(parts) < 6:
            continue
        try:
            size, used = int(parts[1]), int(parts[2])
        except ValueError:
            continue
        mount = " ".join(parts[5:])
        if size <= 0 or parts[0] in seen or mount.startswith(("/snap", "/run", "/dev", "/sys", "/proc")):
            continue
        seen.add(parts[0])
        snap.disks.append(Disk(mount, size, used))
    snap.disks.sort(key=lambda d: (d.mount != "/", -d.size_kb))
    snap.disks = snap.disks[:6]
    for line in s.get("NET", []):
        if ":" not in line:
            continue
        iface, data = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo":
            continue
        cols = data.split()
        if len(cols) >= 9:
            try:
                snap.net_rx += int(cols[0])
                snap.net_tx += int(cols[8])
            except ValueError:
                pass
    for line in s.get("PROC", [])[1:]:
        parts = line.split()
        if len(parts) < 4:
            continue
        try:
            cpu, mem = float(parts[-2]), float(parts[-1])
        except ValueError:
            continue
        snap.procs.append(Proc(parts[0], " ".join(parts[1:-2]), cpu, mem))
    return snap


def parse_services(text: str) -> tuple[Optional[list[Service]], list[Container]]:
    s = _sections(text)
    services: Optional[list[Service]] = []
    if "NOSYSTEMD" in s:
        services = None
    else:
        for line in s.get("SVC", []):
            parts = line.strip().lstrip("●*").split(None, 4)
            if len(parts) < 4:
                continue
            unit = parts[0]
            if not unit.endswith(".service"):
                continue
            services.append(Service(unit, parts[1], parts[2], parts[3], parts[4] if len(parts) > 4 else ""))
    containers = []
    for line in s.get("DOCKER", []):
        parts = line.split("|")
        if len(parts) >= 4:
            containers.append(Container(parts[0], parts[1], parts[2], parts[3]))
    return services, containers


def _fmt_kb(kb: int) -> str:
    return GLib.format_size(int(kb) * 1024)


def _fmt_rate(bps: float) -> str:
    return GLib.format_size(int(max(0, bps))) + "/с"


def _fmt_uptime(seconds: float) -> str:
    seconds = int(seconds)
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        return f"{days} д {hours} ч"
    if hours:
        return f"{hours} ч {minutes} мин"
    return f"{minutes} мин"


# ---------------------------------------------------------------------------
# Виджеты
# ---------------------------------------------------------------------------

_CSS = b"""
levelbar.termuxx-meter block.ok { background-color: #3ddc97; }
levelbar.termuxx-meter block.warn { background-color: #ffb454; }
levelbar.termuxx-meter block.crit { background-color: #ff5c6c; }
levelbar.termuxx-meter trough { min-height: 8px; border-radius: 99px; }
levelbar.termuxx-meter block { border-radius: 99px; }
.termuxx-big { font-size: 26pt; font-weight: 800; font-feature-settings: "tnum"; }
.termuxx-card { padding: 16px; }
.termuxx-dot-ok { color: #3ddc97; }
.termuxx-dot-bad { color: #ff5c6c; }
.termuxx-dot-off { color: alpha(currentColor, 0.35); }
.termuxx-blue { color: #4ea8ff; }
.termuxx-rate { font-size: 15pt; font-weight: 700; font-feature-settings: "tnum"; }
"""
_css_installed = False


def _install_css():
    global _css_installed
    if _css_installed:
        return
    provider = Gtk.CssProvider()
    if hasattr(provider, "load_from_string"):
        provider.load_from_string(_CSS.decode())
    else:
        provider.load_from_data(_CSS, -1)
    display = Gdk.Display.get_default()
    if display is not None:
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    _css_installed = True


def _meter() -> Gtk.LevelBar:
    bar = Gtk.LevelBar(min_value=0, max_value=1, hexpand=True)
    for name in ("low", "high", "full"):
        bar.remove_offset_value(name)
    bar.add_offset_value("ok", 0.70)
    bar.add_offset_value("warn", 0.90)
    bar.add_offset_value("crit", 1.0)
    bar.add_css_class("termuxx-meter")
    return bar


class Sparkline(Gtk.DrawingArea):
    """Маленький график последних значений (одна или две линии)."""

    def __init__(self, colors=(ACCENT,), height=56, fixed_max: Optional[float] = None):
        super().__init__(content_height=height, hexpand=True)
        self.colors = colors
        self.series: list[list[float]] = [[] for _ in colors]
        self.fixed_max = fixed_max
        self.set_draw_func(self._draw, None)

    def push(self, *values: float):
        for series, v in zip(self.series, values):
            series.append(float(v))
            del series[:-HISTORY]
        self.queue_draw()

    def _draw(self, _area, cr, width, height, _data=None):
        # Пунктирные линии сетки — чтобы область графика была видна даже без данных.
        cr.set_source_rgba(1, 1, 1, 0.07)
        cr.set_line_width(1)
        cr.set_dash([3, 4])
        for frac in (0.25, 0.5, 0.75):
            y = round(height * frac) + 0.5
            cr.move_to(0, y)
            cr.line_to(width, y)
            cr.stroke()
        cr.set_dash([])
        top = self.fixed_max or max([max(s) for s in self.series if s] + [1e-9]) * 1.15
        for series, (r, g, b) in zip(self.series, self.colors):
            if len(series) < 2:
                continue
            step = width / (len(series) - 1)
            points = [(i * step, height - 2 - (height - 4) * min(v / top, 1.0)) for i, v in enumerate(series)]
            cr.move_to(points[0][0], height)
            for x, y in points:
                cr.line_to(x, y)
            cr.line_to(points[-1][0], height)
            cr.close_path()
            cr.set_source_rgba(r, g, b, 0.16)
            cr.fill()
            cr.move_to(*points[0])
            for x, y in points[1:]:
                cr.line_to(x, y)
            cr.set_source_rgba(r, g, b, 0.95)
            cr.set_line_width(2)
            cr.stroke()


def _card(title: str, icon: str) -> tuple[Gtk.Box, Gtk.Box]:
    card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, css_classes=["card", "termuxx-card"])
    card.set_size_request(200, -1)
    head = Gtk.Box(spacing=8)
    head.append(Gtk.Image(icon_name=icon, css_classes=["dim-label"]))
    head.append(Gtk.Label(label=title, xalign=0, css_classes=["heading"], hexpand=True))
    card.append(head)
    body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    card.append(body)
    return card, body


def _clear(box: Gtk.Widget):
    child = box.get_first_child()
    while child is not None:
        nxt = child.get_next_sibling()
        box.remove(child)
        child = nxt


# ---------------------------------------------------------------------------
# Окно
# ---------------------------------------------------------------------------


class MonitorWindow(Adw.Window):
    def __init__(self, application, store, server, password=None):
        super().__init__(application=application)
        _install_css()
        self.store = store
        self.server = server
        self.password = password
        self.conn = None
        self.stop_event = threading.Event()
        self.paused = False
        self.prev: Optional[Snapshot] = None
        self.services: Optional[list[Service]] = []
        self.containers: list[Container] = []
        self.service_filter = "failed"
        self._services_loaded = False
        self._last_services = 0.0
        self._exec_lock = threading.Lock()

        self.set_default_size(1120, 820)
        self.set_title(f"Мониторинг — {getattr(server, 'title', '')}")
        self._build_ui()
        self.connect("close-request", self._on_close)
        self.present()
        self._connect()

    # ---------------- интерфейс ----------------

    def _build_ui(self):
        self.toasts = Adw.ToastOverlay()
        toolbar = Adw.ToolbarView()
        self.toasts.set_child(toolbar)
        self.set_content(self.toasts)

        header = Adw.HeaderBar()
        self.title_widget = Adw.WindowTitle(title=getattr(self.server, "title", ""), subtitle="Подключение…")
        header.set_title_widget(self.title_widget)
        self.pause_btn = Gtk.ToggleButton(icon_name="media-playback-pause-symbolic", tooltip_text="Пауза")
        self.pause_btn.connect("toggled", self._on_pause)
        refresh = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Обновить сервисы")
        refresh.connect("clicked", lambda *_: self._refresh_services(force=True))
        header.pack_end(self.pause_btn)
        header.pack_end(refresh)
        toolbar.add_top_bar(header)

        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        loading = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12,
                          valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
        loading.append(Gtk.Spinner(spinning=True, width_request=32, height_request=32))
        loading.append(Gtk.Label(label="Подключение…", css_classes=["dim-label"]))
        self.stack.add_named(loading, "loading")

        self.error_page = Adw.StatusPage(icon_name="network-error-symbolic", title="Нет подключения")
        retry = Gtk.Button(label="Переподключиться", halign=Gtk.Align.CENTER,
                           css_classes=["pill", "suggested-action"])
        retry.connect("clicked", lambda *_: self._connect())
        self.error_page.set_child(retry)
        self.stack.add_named(self.error_page, "error")

        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18,
                       margin_top=18, margin_bottom=24, margin_start=18, margin_end=18)

        # Заголовок с именем хоста
        hero = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.host_label = Gtk.Label(xalign=0, css_classes=["title-1"], ellipsize=Pango.EllipsizeMode.END)
        self.os_label = Gtk.Label(xalign=0, css_classes=["dim-label"], ellipsize=Pango.EllipsizeMode.END)
        hero.append(self.host_label)
        hero.append(self.os_label)
        page.append(hero)

        # Карточки
        flow = Gtk.Grid(column_homogeneous=True, column_spacing=12, row_spacing=12)

        cpu, body = _card("Процессор", "computer-symbolic")
        self.cpu_value = Gtk.Label(xalign=0, label="—", css_classes=["termuxx-big"])
        self.cpu_bar = _meter()
        self.cpu_chart = Sparkline((ACCENT,), fixed_max=100)
        self.cpu_detail = Gtk.Label(xalign=0, css_classes=["dim-label", "caption"], wrap=True, max_width_chars=28)
        for w in (self.cpu_value, self.cpu_bar, self.cpu_chart, self.cpu_detail):
            body.append(w)
        flow.attach(cpu, 0, 0, 1, 1)

        mem, body = _card("Память", "drive-multidisk-symbolic")
        self.mem_value = Gtk.Label(xalign=0, label="—", css_classes=["termuxx-big"])
        self.mem_bar = _meter()
        self.mem_chart = Sparkline((BLUE,), fixed_max=100)
        self.mem_detail = Gtk.Label(xalign=0, css_classes=["dim-label", "caption"], wrap=True, max_width_chars=28)
        self.swap_label = Gtk.Label(xalign=0, css_classes=["dim-label", "caption"])
        for w in (self.mem_value, self.mem_bar, self.mem_chart, self.mem_detail, self.swap_label):
            body.append(w)
        flow.attach(mem, 1, 0, 1, 1)

        net, body = _card("Сеть", "network-transmit-receive-symbolic")
        rates = Gtk.Box(spacing=12)
        self.rx_label = Gtk.Label(xalign=0, label="↓ —", css_classes=["termuxx-rate", "termuxx-dot-ok"])
        self.tx_label = Gtk.Label(xalign=0, label="↑ —", css_classes=["termuxx-rate", "termuxx-blue"])
        rates.append(self.rx_label)
        rates.append(self.tx_label)
        self.net_chart = Sparkline((ACCENT, BLUE))
        self.net_detail = Gtk.Label(xalign=0, css_classes=["dim-label", "caption"], wrap=True, max_width_chars=28)
        for w in (rates, self.net_chart, self.net_detail):
            body.append(w)
        flow.attach(net, 2, 0, 1, 1)
        page.append(flow)

        # Диски
        self.disk_group = Adw.PreferencesGroup(title="Диски")
        self.disk_box = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE, css_classes=["boxed-list"])
        self.disk_group.add(self.disk_box)
        page.append(self.disk_group)

        # Процессы
        self.proc_group = Adw.PreferencesGroup(title="Процессы", description="Топ по загрузке процессора")
        self.proc_rows: list[Adw.ActionRow] = []
        page.append(self.proc_group)

        # Сервисы
        self.svc_group = Adw.PreferencesGroup(title="Сервисы")
        filters = Gtk.Box(css_classes=["linked"], valign=Gtk.Align.CENTER)
        self.filter_buttons = {}
        first = None
        for key, label in (("failed", "Ошибки"), ("running", "Работают"), ("all", "Все")):
            btn = Gtk.ToggleButton(label=label)
            if first is None:
                first = btn
                btn.set_active(True)
            else:
                btn.set_group(first)
            btn.connect("toggled", self._on_filter, key)
            filters.append(btn)
            self.filter_buttons[key] = btn
        self.svc_search = Gtk.SearchEntry(placeholder_text="Поиск сервиса", width_chars=18, valign=Gtk.Align.CENTER)
        self.svc_search.connect("search-changed", lambda *_: self._render_services())
        suffix = Gtk.Box(spacing=8)
        suffix.append(self.svc_search)
        suffix.append(filters)
        self.svc_group.set_header_suffix(suffix)
        self.svc_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE, css_classes=["boxed-list"])
        self.svc_group.add(self.svc_list)
        page.append(self.svc_group)

        # Docker
        self.docker_group = Adw.PreferencesGroup(title="Docker", visible=False)
        self.docker_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE, css_classes=["boxed-list"])
        self.docker_group.add(self.docker_list)
        page.append(self.docker_group)

        clamp = Adw.Clamp(maximum_size=1180, child=page)
        scroll = Gtk.ScrolledWindow(child=clamp, vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
        self.stack.add_named(scroll, "main")
        self.stack.set_visible_child_name("loading")
        toolbar.set_content(self.stack)

        esc = Gtk.ShortcutController()
        esc.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string("<Control>w"),
                                          Gtk.CallbackAction.new(lambda *_: (self.close(), True)[1])))
        esc.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string("F5"),
                                          Gtk.CallbackAction.new(lambda *_: (self._refresh_services(True), True)[1])))
        self.add_controller(esc)

    def toast(self, text: str, timeout: int = 4):
        self.toasts.add_toast(Adw.Toast(title=GLib.markup_escape_text(text), timeout=timeout))

    # ---------------- подключение и опрос ----------------

    def _connect(self):
        self.stack.set_visible_child_name("loading")
        self.title_widget.set_subtitle("Подключение…")
        self.stop_event.set()
        self.stop_event = threading.Event()

        def connected(conn):
            if self.stop_event.is_set():
                run_in_thread(conn.close)
                return
            self.conn = conn
            self.prev = None
            self._services_loaded = False
            threading.Thread(target=self._poll_loop, args=(conn, self.stop_event), daemon=True).start()

        sshconn.connect_interactive(self, self.store, self.server, self.password, connected, self._fatal)

    def _fatal(self, e: BaseException):
        if self.stop_event.is_set() and not isinstance(e, sshconn.SSHError):
            return
        self.error_page.set_description(GLib.markup_escape_text(describe_error(e)))
        self.title_widget.set_subtitle("нет подключения")
        self.stack.set_visible_child_name("error")

    def _run(self, conn, script: str, timeout: float = 25):
        with self._exec_lock:
            return conn.run_script(script, timeout=timeout)

    def _poll_loop(self, conn, stop: threading.Event):
        failures = 0
        while not stop.is_set():
            if not self.paused:
                try:
                    _code, out = self._run(conn, METRICS_SCRIPT)
                    snap = parse_metrics(out)
                    GLib.idle_add(self._apply_snapshot, snap)
                    failures = 0
                    if time.monotonic() - self._last_services > SERVICES_EVERY or not self._services_loaded:
                        self._last_services = time.monotonic()
                        _code, out = self._run(conn, SERVICES_SCRIPT, timeout=40)
                        services, containers = parse_services(out)
                        GLib.idle_add(self._apply_services, services, containers)
                except Exception as e:  # noqa: BLE001
                    failures += 1
                    if not conn.is_active or failures >= 3:
                        if not stop.is_set():
                            GLib.idle_add(self._fatal, sshconn.SSHError("Соединение потеряно: " + describe_error(e)))
                        return
            stop.wait(POLL_SECONDS)

    def _refresh_services(self, force: bool = False):
        conn = self.conn
        if conn is None:
            return

        def work():
            _code, out = self._run(conn, SERVICES_SCRIPT, timeout=40)
            return parse_services(out)

        run_in_thread(work, lambda r: self._apply_services(*r), lambda e: self.toast(describe_error(e)))

    def _on_pause(self, btn):
        self.paused = btn.get_active()
        btn.set_icon_name("media-playback-start-symbolic" if self.paused else "media-playback-pause-symbolic")
        btn.set_tooltip_text("Продолжить" if self.paused else "Пауза")
        self._update_subtitle()

    def _update_subtitle(self):
        if self.paused:
            self.title_widget.set_subtitle("пауза")
        else:
            self.title_widget.set_subtitle(f"{getattr(self.server, 'subtitle', '')} · каждые {POLL_SECONDS} с")

    def _on_close(self, *_):
        self.stop_event.set()
        conn, self.conn = self.conn, None
        if conn is not None:
            threading.Thread(target=conn.close, daemon=True).start()
        return False

    # ---------------- отображение ----------------

    def _apply_snapshot(self, snap: Snapshot):
        if self.stop_event.is_set():
            return False
        prev = self.prev
        self.prev = snap
        if self.stack.get_visible_child_name() != "main":
            self.stack.set_visible_child_name("main")
            self._update_subtitle()

        self.host_label.set_label(snap.hostname or getattr(self.server, "hostname", ""))
        bits = [b for b in (snap.os_name, snap.kernel and f"ядро {snap.kernel}",
                            f"аптайм {_fmt_uptime(snap.uptime)}") if b]
        self.os_label.set_label(" · ".join(bits))

        # CPU
        if prev is not None and snap.cpu_total > prev.cpu_total:
            dt = snap.cpu_total - prev.cpu_total
            di = snap.cpu_idle - prev.cpu_idle
            cpu = max(0.0, min(100.0, 100.0 * (1 - di / dt)))
            self.cpu_value.set_label(f"{cpu:.0f}%")
            self.cpu_bar.set_value(cpu / 100)
            self.cpu_chart.push(cpu)
        elif prev is None:
            self.cpu_value.set_label("…")
        self.cpu_detail.set_label(
            f"Нагрузка {snap.load[0]:.2f} · {snap.load[1]:.2f} · {snap.load[2]:.2f} · ядер: {snap.cores}"
        )

        # Память
        if snap.mem_total:
            used = snap.mem_total - snap.mem_available
            frac = used / snap.mem_total
            self.mem_value.set_label(f"{frac * 100:.0f}%")
            self.mem_bar.set_value(frac)
            self.mem_chart.push(frac * 100)
            self.mem_detail.set_label(f"{_fmt_kb(used)} из {_fmt_kb(snap.mem_total)} · свободно {_fmt_kb(snap.mem_available)}")
        if snap.swap_total:
            sused = snap.swap_total - snap.swap_free
            self.swap_label.set_label(f"Своп: {_fmt_kb(sused)} из {_fmt_kb(snap.swap_total)}")
        else:
            self.swap_label.set_label("Своп выключен")

        # Диски
        _clear(self.disk_box)
        if not snap.disks:
            self.disk_box.append(Adw.ActionRow(title="Нет данных"))
        for d in snap.disks:
            row = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6,
                          margin_top=10, margin_bottom=10, margin_start=12, margin_end=12)
            top = Gtk.Box(spacing=10)
            top.append(Gtk.Label(label=d.mount, xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.MIDDLE,
                                 css_classes=["monospace"]))
            top.append(Gtk.Label(label=f"{_fmt_kb(d.used_kb)} из {_fmt_kb(d.size_kb)}",
                                 css_classes=["dim-label", "caption"]))
            top.append(Gtk.Label(label=f"{d.fraction * 100:.0f}%", width_chars=5, xalign=1,
                                 css_classes=["caption-heading", "numeric"]))
            row.append(top)
            bar = _meter()
            bar.set_value(min(1.0, d.fraction))
            row.append(bar)
            self.disk_box.append(row)

        # Сеть
        if prev is not None and snap.taken > prev.taken:
            dt = snap.taken - prev.taken
            rx = max(0, snap.net_rx - prev.net_rx) / dt
            tx = max(0, snap.net_tx - prev.net_tx) / dt
            self.rx_label.set_label(f"↓ {_fmt_rate(rx)}")
            self.tx_label.set_label(f"↑ {_fmt_rate(tx)}")
            self.net_chart.push(rx, tx)
        self.net_detail.set_label(
            f"Всего: ↓ {GLib.format_size(snap.net_rx)} · ↑ {GLib.format_size(snap.net_tx)}"
        )

        # Процессы
        for row in self.proc_rows:
            self.proc_group.remove(row)
        self.proc_rows = []
        for p in snap.procs[:8]:
            row = Adw.ActionRow(title=GLib.markup_escape_text(p.name), subtitle=f"PID {p.pid}")
            cpu_label = Gtk.Label(label=f"{p.cpu:.1f}% CPU", css_classes=["numeric"], width_chars=10, xalign=1)
            mem_label = Gtk.Label(label=f"{p.mem:.1f}% RAM", css_classes=["numeric", "dim-label"],
                                  width_chars=10, xalign=1)
            row.add_suffix(cpu_label)
            row.add_suffix(mem_label)
            self.proc_group.add(row)
            self.proc_rows.append(row)
        return False

    def _on_filter(self, btn, key):
        if btn.get_active():
            self.service_filter = key
            self._render_services()

    def _apply_services(self, services, containers):
        self._services_loaded = True
        self.services = services
        self.containers = containers
        self._render_services()
        self._render_docker()
        return False

    def _render_services(self):
        _clear(self.svc_list)
        if self.services is None:
            self.svc_group.set_description("systemd на сервере недоступен")
            return
        failed = [s for s in self.services if s.active == "failed"]
        running = [s for s in self.services if s.sub == "running"]
        self.svc_group.set_description(f"Работают: {len(running)} · с ошибками: {len(failed)}")
        if self.service_filter == "failed":
            items = failed
        elif self.service_filter == "running":
            items = running
        else:
            items = [s for s in self.services if s.load != "not-found"]
        query = self.svc_search.get_text().strip().casefold()
        if query:
            items = [s for s in items if query in s.unit.casefold() or query in s.description.casefold()]
        if not items:
            text = "Сервисов с ошибками нет 👍" if self.service_filter == "failed" and not query else "Ничего не найдено"
            row = Adw.ActionRow(title=text)
            row.add_css_class("dim-label")
            self.svc_list.append(row)
            return
        for svc in items[:200]:
            self.svc_list.append(self._service_row(svc))

    def _service_row(self, svc: Service) -> Adw.ActionRow:
        row = Adw.ActionRow(title=GLib.markup_escape_text(svc.name),
                            subtitle=GLib.markup_escape_text(f"{svc.active} ({svc.sub}) · {svc.description}"))
        row.set_subtitle_lines(1)
        dot = Gtk.Label(label="●")
        if svc.active == "failed":
            dot.add_css_class("termuxx-dot-bad")
        elif svc.sub == "running":
            dot.add_css_class("termuxx-dot-ok")
        else:
            dot.add_css_class("termuxx-dot-off")
        row.add_prefix(dot)
        row.add_suffix(self._actions_button([
            ("Перезапустить", lambda: self._service_action(svc, "restart")),
            ("Запустить", lambda: self._service_action(svc, "start")),
            ("Остановить", lambda: self._service_action(svc, "stop")),
            ("Логи", lambda: self._service_logs(svc)),
        ]))
        return row

    def _actions_button(self, actions) -> Gtk.MenuButton:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, margin_top=6, margin_bottom=6,
                      margin_start=6, margin_end=6)
        popover = Gtk.Popover(child=box)
        for label, fn in actions:
            b = Gtk.Button(label=label, css_classes=["flat"])
            b.get_child().set_xalign(0)

            def clicked(_b, fn=fn):
                popover.popdown()
                fn()

            b.connect("clicked", clicked)
            box.append(b)
        return Gtk.MenuButton(icon_name="view-more-symbolic", popover=popover,
                              css_classes=["flat"], valign=Gtk.Align.CENTER, tooltip_text="Действия")

    def _sudo(self) -> str:
        return "" if getattr(self.server, "username", "root") == "root" else "sudo -n "

    def _service_action(self, svc: Service, action: str):
        conn = self.conn
        if conn is None:
            return
        verbs = {"restart": "Перезапуск", "start": "Запуск", "stop": "Остановка"}
        self.toast(f"{verbs.get(action, action)}: {svc.name}…", timeout=2)
        cmd = f"{self._sudo()}systemctl {action} {shlex.quote(svc.unit)} 2>&1"

        def work():
            with self._exec_lock:
                return conn.exec(cmd, timeout=60)

        def done(result):
            code, out = result
            if code == 0:
                self.toast(f"Готово: {svc.name}")
            elif "password is required" in out or "a terminal is required" in out:
                self.toast("Нужны права root: настройте sudo без пароля или войдите как root", 6)
            else:
                self.toast(f"Ошибка ({code}): {out.strip()[:200]}", 8)
            self._refresh_services(True)

        run_in_thread(work, done, lambda e: self.toast(describe_error(e)))

    def _service_logs(self, svc: Service):
        self._show_command_output(f"Логи {svc.name}",
                                  f"journalctl -u {shlex.quote(svc.unit)} -n 300 --no-pager 2>&1 || "
                                  f"{self._sudo()}journalctl -u {shlex.quote(svc.unit)} -n 300 --no-pager 2>&1")

    def _render_docker(self):
        _clear(self.docker_list)
        self.docker_group.set_visible(bool(self.containers))
        if not self.containers:
            return
        running = sum(1 for c in self.containers if c.state == "running")
        self.docker_group.set_description(f"Контейнеров: {len(self.containers)} · работают: {running}")
        for c in self.containers:
            row = Adw.ActionRow(title=GLib.markup_escape_text(c.name),
                                subtitle=GLib.markup_escape_text(f"{c.status} · {c.image}"))
            dot = Gtk.Label(label="●")
            dot.add_css_class("termuxx-dot-ok" if c.state == "running" else
                              ("termuxx-dot-bad" if c.state in ("exited", "dead") else "termuxx-dot-off"))
            row.add_prefix(dot)
            row.add_suffix(self._actions_button([
                ("Перезапустить", lambda c=c: self._docker_action(c, "restart")),
                ("Запустить", lambda c=c: self._docker_action(c, "start")),
                ("Остановить", lambda c=c: self._docker_action(c, "stop")),
                ("Логи", lambda c=c: self._show_command_output(
                    f"Логи {c.name}", f"docker logs --tail 300 {shlex.quote(c.name)} 2>&1")),
            ]))
            self.docker_list.append(row)

    def _docker_action(self, c: Container, action: str):
        conn = self.conn
        if conn is None:
            return
        self.toast(f"docker {action} {c.name}…", timeout=2)

        def work():
            with self._exec_lock:
                return conn.exec(f"docker {action} {shlex.quote(c.name)} 2>&1", timeout=90)

        def done(result):
            code, out = result
            self.toast("Готово" if code == 0 else f"Ошибка ({code}): {out.strip()[:200]}", 4 if code == 0 else 8)
            self._refresh_services(True)

        run_in_thread(work, done, lambda e: self.toast(describe_error(e)))

    def _show_command_output(self, title: str, cmd: str):
        conn = self.conn
        if conn is None:
            return
        win = Adw.Window(transient_for=self, modal=False, title=title, default_width=900, default_height=620)
        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        header.set_title_widget(Adw.WindowTitle(title=title, subtitle=getattr(self.server, "title", "")))
        copy = Gtk.Button(icon_name="edit-copy-symbolic", tooltip_text="Скопировать")
        header.pack_end(copy)
        toolbar.add_top_bar(header)
        buffer = Gtk.TextBuffer()
        buffer.set_text("Загрузка…")
        view = Gtk.TextView(buffer=buffer, editable=False, monospace=True, cursor_visible=False,
                            wrap_mode=Gtk.WrapMode.WORD_CHAR, top_margin=10, bottom_margin=10,
                            left_margin=12, right_margin=12)
        scroll = Gtk.ScrolledWindow(child=view, vexpand=True)
        toolbar.set_content(scroll)
        win.set_content(toolbar)

        def do_copy(*_):
            start, end = buffer.get_bounds()
            Gdk.Display.get_default().get_clipboard().set(buffer.get_text(start, end, False))

        copy.connect("clicked", do_copy)
        win.present()

        def work():
            with self._exec_lock:
                return conn.exec(cmd, timeout=60)

        def done(result):
            _code, out = result
            buffer.set_text(out.strip() or "(пусто)")
            GLib.idle_add(lambda: (scroll.get_vadjustment().set_value(scroll.get_vadjustment().get_upper()), False)[1])

        run_in_thread(work, done, lambda e: buffer.set_text(describe_error(e)))
