// Мониторинг сервера по SSH: CPU, память, диски, сеть, процессы; сервисы systemd и Docker.
// Скрипт и разбор совпадают с iOS (Termuxx/Monitor/ServerMonitor.swift).
import { IPC } from '../../shared/api';
import type { ContainerInfo, MonitorSnapshot, ServiceInfo } from '../../shared/types';
import type { MainContext } from '../contracts';
import { SshSession, getSession, requireSession } from './session';
import { execCommand, friendlyMessage, scriptSections, sh, shQuote } from './util';

const METRICS_SCRIPT = `export LC_ALL=C
echo @@UID; id -u 2>/dev/null
echo @@LOADAVG; cat /proc/loadavg 2>/dev/null
echo @@NPROC; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null
echo @@STAT; head -n 1 /proc/stat 2>/dev/null
echo @@MEM; grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null
echo @@DISK; df -kP 2>/dev/null | tail -n +2
echo @@UPTIME; cat /proc/uptime 2>/dev/null
echo @@HOST; hostname 2>/dev/null || cat /etc/hostname 2>/dev/null
echo @@OS; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" )
echo @@KERNEL; uname -r 2>/dev/null
echo @@NET; tail -n +3 /proc/net/dev 2>/dev/null
echo @@PROC; ps -eo pid=,comm=,pcpu=,pmem= --sort=-pcpu 2>/dev/null | head -n 8
echo @@END`;

const SERVICES_SCRIPT = `export LC_ALL=C
echo @@SVC
if command -v systemctl >/dev/null 2>&1; then systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null; else echo @@NOSYSTEMD; fi
echo @@END`;

const CONTAINERS_SCRIPT = `export LC_ALL=C
echo @@DOCKER
if command -v docker >/dev/null 2>&1; then docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}" 2>/dev/null || sudo -n docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}" 2>/dev/null; fi
echo @@END`;

const VIRTUAL_IFACES = ['lo', 'veth', 'docker', 'br-', 'virbr', 'cni', 'flannel', 'cali', 'vnet', 'kube', 'tun', 'wg', 'tailscale', 'zt', 'ifb'];

/** Состояние разбора между замерами (для CPU% и скорости сети). */
export class MetricsParser {
  private prevCpu: { total: number; idle: number } | null = null;
  private prevNet: { rx: number; tx: number; time: number } | null = null;
  isRoot: boolean | null = null;

  /** Разобрать вывод METRICS_SCRIPT. Бросает, если это не Linux. */
  parse(output: string, now = Date.now()): MonitorSnapshot {
    const sections = scriptSections(output);
    if (!sections.has('END')) throw new Error('Сервер вернул неожиданный ответ. Мониторинг работает только с Linux.');
    const first = (name: string) => (sections.get(name)?.[0] ?? '').trim();

    const uid = first('UID');
    if (uid) this.isRoot = uid === '0';

    const load = first('LOADAVG').split(/\s+/).slice(0, 3).map(Number).map((n) => (Number.isFinite(n) ? n : 0));
    while (load.length < 3) load.push(0);
    const cores = Math.max(1, parseInt(first('NPROC'), 10) || 1);

    // CPU по разнице двух замеров /proc/stat; первый раз — среднее с момента загрузки.
    let cpu = 0;
    const statLine = first('STAT');
    const values = statLine.split(/\s+/).slice(1).map((v) => Number(v)).filter((v) => Number.isFinite(v));
    if (values.length >= 4) {
      const total = values.slice(0, 8).reduce((a, b) => a + b, 0);
      const idle = values[3] + (values.length > 4 ? values[4] : 0);
      if (this.prevCpu && total > this.prevCpu.total) {
        const dTotal = total - this.prevCpu.total;
        const dIdle = Math.max(0, idle - this.prevCpu.idle);
        cpu = (1 - dIdle / dTotal) * 100;
      } else if (total > 0) {
        cpu = (1 - idle / total) * 100;
      }
      this.prevCpu = { total, idle };
    }
    cpu = Math.max(0, Math.min(100, cpu));

    const mem: Record<string, number> = {};
    for (const line of sections.get('MEM') ?? []) {
      const [key, rest] = line.split(':', 2);
      if (!rest) continue;
      mem[key.trim()] = (parseInt(rest.trim().split(/\s+/)[0], 10) || 0) * 1024;
    }
    const memTotal = mem.MemTotal ?? 0;
    const memAvailable = mem.MemAvailable ?? ((mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0));

    const disks: MonitorSnapshot['disks'] = [];
    const seen = new Set<string>();
    for (const line of sections.get('DISK') ?? []) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const fsName = parts[0];
      const size = parseInt(parts[1], 10);
      const used = parseInt(parts[2], 10);
      const mount = parts.slice(5).join(' ');
      if (!Number.isFinite(size) || !Number.isFinite(used) || size <= 0) continue;
      const isDevice = fsName.startsWith('/dev/') && !fsName.startsWith('/dev/loop');
      if (!(isDevice || mount === '/') || seen.has(fsName)) continue;
      if (mount.startsWith('/snap') || mount.startsWith('/boot/efi')) continue;
      seen.add(fsName);
      disks.push({ mount, size: size * 1024, used: used * 1024 });
    }
    disks.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : b.size - a.size));

    const uptime = parseFloat(first('UPTIME').split(/\s+/)[0]) || 0;

    // Сеть — сумма «настоящих» интерфейсов.
    const ifaces: { name: string; rx: number; tx: number }[] = [];
    for (const line of sections.get('NET') ?? []) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const name = line.slice(0, idx).trim();
      const fields = line.slice(idx + 1).trim().split(/\s+/).map(Number);
      if (fields.length < 9) continue;
      ifaces.push({ name, rx: fields[0] || 0, tx: fields[8] || 0 });
    }
    let physical = ifaces.filter((i) => !VIRTUAL_IFACES.some((p) => i.name.startsWith(p)));
    if (!physical.length) physical = ifaces.filter((i) => i.name !== 'lo');
    const rx = physical.reduce((n, i) => n + i.rx, 0);
    const tx = physical.reduce((n, i) => n + i.tx, 0);
    let netRx = 0;
    let netTx = 0;
    if (this.prevNet) {
      const dt = (now - this.prevNet.time) / 1000;
      if (dt > 0.2) {
        netRx = rx >= this.prevNet.rx ? (rx - this.prevNet.rx) / dt : 0;
        netTx = tx >= this.prevNet.tx ? (tx - this.prevNet.tx) / dt : 0;
      }
    }
    this.prevNet = { rx, tx, time: now };

    const processes: MonitorSnapshot['processes'] = [];
    for (const line of sections.get('PROC') ?? []) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const pid = parseInt(parts[0], 10);
      const pcpu = parseFloat(parts[parts.length - 2]);
      const pmem = parseFloat(parts[parts.length - 1]);
      if (!Number.isFinite(pid) || !Number.isFinite(pcpu) || !Number.isFinite(pmem)) continue;
      processes.push({ pid, name: parts.slice(1, parts.length - 2).join(' '), cpu: pcpu, mem: pmem });
    }

    return {
      hostname: first('HOST'),
      os: first('OS'),
      kernel: first('KERNEL'),
      uptime,
      load: [load[0], load[1], load[2]],
      cores,
      cpu,
      memTotal,
      memAvailable,
      swapTotal: mem.SwapTotal ?? 0,
      swapFree: mem.SwapFree ?? 0,
      disks,
      netRx,
      netTx,
      processes,
      time: now,
    };
  }
}

export function parseServices(output: string): ServiceInfo[] {
  const sections = scriptSections(output);
  const list: ServiceInfo[] = [];
  for (const raw of sections.get('SVC') ?? []) {
    let line = raw.trim();
    if (line === '@@NOSYSTEMD') continue;
    if (line.startsWith('●') || line.startsWith('*')) line = line.slice(1).trim();
    const parts = line.split(/\s+/);
    if (parts.length < 4 || !parts[0].endsWith('.service')) continue;
    const [unit, load, active, sub] = parts;
    const description = parts.slice(4).join(' ');
    if (load === 'not-found' && active !== 'failed') continue;
    list.push({ name: unit, active, sub, description });
  }
  const rank = (s: ServiceInfo) => (s.active === 'failed' ? 0 : s.sub === 'running' ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

export function parseContainers(output: string): ContainerInfo[] {
  const sections = scriptSections(output);
  const list: ContainerInfo[] = [];
  for (const line of sections.get('DOCKER') ?? []) {
    const parts = line.split('|');
    if (parts.length < 3 || !parts[0]) continue;
    const status = parts[1];
    list.push({ name: parts[0], status, image: parts.slice(2).join('|'), running: /^up\b/i.test(status) });
  }
  return list.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

// ---------------------------------------------------------------------------

interface Poller {
  timer: NodeJS.Timeout | null;
  interval: number;
  parser: MetricsParser;
  busy: boolean;
  stopped: boolean;
}

const pollers = new Map<string, Poller>();

export function monitorStart(ctx: MainContext, sessionId: string, intervalMs?: number): void {
  const interval = Math.max(1000, Math.min(60_000, Number(intervalMs) || 3000));
  const existing = pollers.get(sessionId);
  if (existing && !existing.stopped) {
    existing.interval = interval;
    return;
  }
  const poller: Poller = { timer: null, interval, parser: new MetricsParser(), busy: false, stopped: false };
  pollers.set(sessionId, poller);
  const session = getSession(sessionId);
  session?.disposers.add(() => monitorStop(sessionId));

  const tick = async (fast: boolean) => {
    if (poller.stopped) return;
    poller.busy = true;
    try {
      const s = requireSession(sessionId);
      const { output } = await execCommand(s.connection!.client, sh(METRICS_SCRIPT), { timeoutMs: 15_000, maxBytes: 1024 * 1024 });
      const snapshot = poller.parser.parse(output);
      if (poller.parser.isRoot !== null) s.isRoot = poller.parser.isRoot;
      if (!poller.stopped) ctx.broadcast(IPC.monitor, { sessionId, snapshot });
    } catch (err) {
      if (!poller.stopped) ctx.broadcast(IPC.monitor, { sessionId, snapshot: null, error: friendlyMessage(err) });
      const s = getSession(sessionId);
      if (!s || !s.connected) {
        monitorStop(sessionId);
        return;
      }
    } finally {
      poller.busy = false;
    }
    if (poller.stopped) return;
    // Второй замер — быстро, чтобы CPU и сеть появились почти сразу.
    poller.timer = setTimeout(() => void tick(false), fast ? 1000 : poller.interval);
  };
  void tick(true);
}

export function monitorStop(sessionId: string): void {
  const poller = pollers.get(sessionId);
  if (!poller) return;
  poller.stopped = true;
  if (poller.timer) clearTimeout(poller.timer);
  pollers.delete(sessionId);
}

export function stopAllMonitors(): void {
  for (const id of [...pollers.keys()]) monitorStop(id);
}

async function isRoot(session: SshSession): Promise<boolean> {
  if (session.isRoot !== null) return session.isRoot;
  try {
    const { output } = await execCommand(session.connection!.client, 'id -u', { timeoutMs: 8000 });
    session.isRoot = output.trim() === '0';
  } catch {
    session.isRoot = false;
  }
  return session.isRoot;
}

export async function listServices(sessionId: string): Promise<ServiceInfo[]> {
  const s = requireSession(sessionId);
  const { output } = await execCommand(s.connection!.client, sh(SERVICES_SCRIPT), { timeoutMs: 20_000 });
  return parseServices(output);
}

export async function listContainers(sessionId: string): Promise<ContainerInfo[]> {
  const s = requireSession(sessionId);
  const { output } = await execCommand(s.connection!.client, sh(CONTAINERS_SCRIPT), { timeoutMs: 20_000 });
  return parseContainers(output);
}

type Action = 'restart' | 'start' | 'stop' | 'logs';

function explain(output: string, code: number | null, okText: string): string {
  const text = output.trim();
  if (code === 0) return text || okText;
  if (/a password is required|interactive authentication required|not in the sudoers/i.test(text)) {
    return 'Нужны права root (sudo с паролем не поддерживается). Подключитесь как root или настройте sudo без пароля.';
  }
  return text || `Ошибка (код ${code ?? '?'})`;
}

export async function serviceAction(sessionId: string, name: string, action: Action): Promise<string> {
  const s = requireSession(sessionId);
  const root = await isRoot(s);
  const unit = shQuote(name);
  if (action === 'logs') {
    const base = `journalctl -u ${unit} -n 200 --no-pager`;
    const script = root ? `${base} 2>&1` : `sudo -n ${base} 2>/dev/null || ${base} 2>&1`;
    const { output } = await execCommand(s.connection!.client, sh(script), { timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 });
    return output.trim() || '(журнал пуст)';
  }
  if (!['restart', 'start', 'stop'].includes(action)) throw new Error('Неизвестное действие.');
  const script = `${root ? '' : 'sudo -n '}systemctl ${action} ${unit} 2>&1`;
  const { output, code } = await execCommand(s.connection!.client, sh(script), { timeoutMs: 60_000 });
  return explain(output, code, 'Готово');
}

export async function containerAction(sessionId: string, name: string, action: Action): Promise<string> {
  const s = requireSession(sessionId);
  const root = await isRoot(s);
  const quoted = shQuote(name);
  if (action === 'logs') {
    const base = `docker logs --tail 200 ${quoted}`;
    const { output } = await execCommand(s.connection!.client, sh(`${base} 2>&1 || sudo -n ${base} 2>&1`), { timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 });
    return output.trim() || '(журнал пуст)';
  }
  if (!['restart', 'start', 'stop'].includes(action)) throw new Error('Неизвестное действие.');
  const docker = `docker ${action} ${quoted}`;
  const script = root ? `${docker} 2>&1` : `${docker} >/dev/null 2>&1 && echo OK || sudo -n ${docker} 2>&1`;
  const { output, code } = await execCommand(s.connection!.client, sh(script), { timeoutMs: 60_000 });
  return explain(output.replace(/^OK\s*$/m, '').trim() ? output : '', code, 'Готово');
}
