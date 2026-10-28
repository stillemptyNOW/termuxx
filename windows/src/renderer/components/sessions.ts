// Связь панелей с сессиями main-процесса: открытие, данные, статусы, переподключение, MultiExec.
import type { SessionStatusEvent, Server } from '../../shared/types';
import { activeLocation, errorText, useApp } from '../state';
import { disposeTerm, getTerm, setTermHooks, termSize } from './terminals';
import { toast } from '../ui/kit';

const sessionToPane = new Map<string, string>();
const pendingData = new Map<string, { chunks: string[]; size: number; at: number }>();
const pendingStatus = new Map<string, SessionStatusEvent[]>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const connecting = new Set<string>();
let started = false;

const api = () => window.termuxx;

function dim(text: string) { return `\x1b[2m${text}\x1b[0m`; }

function bufferData(sessionId: string, data: string) {
  let p = pendingData.get(sessionId);
  if (!p) {
    p = { chunks: [], size: 0, at: Date.now() };
    pendingData.set(sessionId, p);
    // старые «бесхозные» буферы чистим
    for (const [id, v] of pendingData) {
      if (Date.now() - v.at > 60_000) pendingData.delete(id);
    }
  }
  if (p.size > 2_000_000) return;
  p.chunks.push(data);
  p.size += data.length;
}

function bindSession(sessionId: string, paneId: string) {
  sessionToPane.set(sessionId, paneId);
  const entry = getTerm(paneId);
  const buffered = pendingData.get(sessionId);
  if (buffered) {
    pendingData.delete(sessionId);
    for (const chunk of buffered.chunks) entry?.term.write(chunk);
  }
  const statuses = pendingStatus.get(sessionId);
  if (statuses) {
    pendingStatus.delete(sessionId);
    for (const s of statuses) applyStatus(paneId, s);
  }
}

function beep() {
  try {
    const AC = (window as unknown as { AudioContext: typeof AudioContext }).AudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => void ctx.close();
  } catch {
    /* без звука */
  }
}

function applyStatus(paneId: string, e: SessionStatusEvent) {
  const st = useApp.getState();
  const loc = st.findPane(paneId);
  if (!loc) return;
  const entry = getTerm(paneId);

  if (e.status === 'connecting') {
    st.updatePane(paneId, { status: 'connecting', message: e.message });
    return;
  }
  if (e.status === 'connected') {
    st.updatePane(paneId, { status: 'connected', message: undefined, dropped: false, reconnectAttempt: 0 });
    const pt = useApp.getState().pendingTool;
    if (pt && pt.paneId === paneId && loc.pane.serverId) {
      st.setPendingTool(null);
      st.setDialog({ type: pt.tool, sessionId: e.sessionId, serverId: loc.pane.serverId });
    }
    return;
  }

  // closed / error
  sessionToPane.delete(e.sessionId);
  const server = st.server(loc.pane.serverId);
  const attempt = loc.pane.reconnectAttempt;
  const willRetry = !!(e.dropped && loc.pane.kind === 'ssh' && server?.autoReconnect && attempt < 3);
  st.updatePane(paneId, {
    status: e.status,
    message: e.message,
    dropped: !!e.dropped,
    sessionId: null,
  });
  if (entry) {
    if (e.status === 'error') {
      entry.term.write(`\r\n\x1b[31m✗ ${(e.message ?? 'Ошибка подключения').replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
    } else if (e.dropped) {
      entry.term.write(`\r\n\x1b[33m⚠ ${e.message ?? 'Соединение потеряно'}\x1b[0m\r\n`);
    } else {
      const code = e.exitCode != null ? ` (код ${e.exitCode})` : '';
      entry.term.write(`\r\n${dim(`— сессия завершена${code} —`)}\r\n`);
    }
  }
  if (willRetry) {
    const delay = 2000 * (attempt + 1);
    entry?.term.write(dim(`  переподключение через ${delay / 1000} с…`) + '\r\n');
    const timer = setTimeout(() => {
      reconnectTimers.delete(paneId);
      const now = useApp.getState().findPane(paneId);
      if (!now || now.pane.status === 'connected' || now.pane.status === 'connecting') return;
      useApp.getState().updatePane(paneId, { reconnectAttempt: attempt + 1 });
      void connectPane(paneId);
    }, delay);
    reconnectTimers.set(paneId, timer);
  }
}

/** Запускается один раз при старте приложения. */
export function startSessionBus() {
  if (started) return;
  started = true;
  const a = api();

  a.onSessionData((e) => {
    const paneId = sessionToPane.get(e.sessionId);
    if (!paneId) {
      bufferData(e.sessionId, e.data);
      return;
    }
    getTerm(paneId)?.term.write(e.data);
  });

  a.onSessionStatus((e) => {
    const paneId = sessionToPane.get(e.sessionId);
    if (!paneId) {
      const list = pendingStatus.get(e.sessionId) ?? [];
      list.push(e);
      pendingStatus.set(e.sessionId, list);
      return;
    }
    applyStatus(paneId, e);
  });

  setTermHooks({
    onData(paneId, data) {
      const st = useApp.getState();
      const loc = st.findPane(paneId);
      if (!loc) return;
      const { pane, tab } = loc;
      if (pane.sessionId && pane.status === 'connected') {
        a.write(pane.sessionId, data);
      } else if (pane.status === 'closed' || pane.status === 'error') {
        // Enter в закрытой сессии — переподключиться (как в MobaXterm «R»)
        if (data === '\r' || data === 'r' || data === 'R') void reconnectPane(paneId);
        return;
      }
      if (st.multiExec && tab.multiExec) {
        for (const t of st.tabs) {
          if (!t.multiExec) continue;
          for (const p of t.panes) {
            if (p.id !== paneId && p.sessionId && p.status === 'connected') a.write(p.sessionId, data);
          }
        }
      }
    },
    onResize(paneId, cols, rows) {
      const loc = useApp.getState().findPane(paneId);
      if (loc?.pane.sessionId) a.resize(loc.pane.sessionId, cols, rows);
    },
    onTitle(paneId, title) {
      useApp.getState().updatePane(paneId, { title });
    },
    onBell(paneId) {
      const st = useApp.getState();
      const loc = st.findPane(paneId);
      if (!loc) return;
      if (st.activeTabId !== loc.tab.id) st.setTabFlag(loc.tab.id, { bell: true });
      if (st.settings().bellSound) beep();
    },
    onSelection(_paneId, text) {
      if (useApp.getState().settings().copyOnSelect && text) a.clipboardWrite(text);
    },
    onOpened(paneId) {
      const loc = useApp.getState().findPane(paneId);
      if (loc && loc.pane.status === 'idle') void connectPane(paneId);
    },
  });
}

/** Открыть (или переоткрыть) сессию для панели. */
export async function connectPane(paneId: string) {
  if (connecting.has(paneId)) return;
  const st = useApp.getState();
  const loc = st.findPane(paneId);
  if (!loc) return;
  const { pane } = loc;
  const entry = getTerm(paneId);
  const { cols, rows } = termSize(paneId);
  connecting.add(paneId);
  st.updatePane(paneId, { status: 'connecting', message: undefined, dropped: false });

  if (pane.kind === 'ssh') {
    const server = st.server(pane.serverId);
    if (!server) {
      connecting.delete(paneId);
      st.updatePane(paneId, { status: 'error', message: 'Сервер удалён из списка' });
      return;
    }
    entry?.term.write(dim(`→ ${server.username}@${server.hostname}${server.port !== 22 ? `:${server.port}` : ''}`) + '\r\n');
  }

  try {
    const res = pane.kind === 'ssh'
      ? await api().openSession({ kind: 'ssh', serverId: pane.serverId!, cols, rows })
      : await api().openSession({ kind: 'local', shellId: pane.shellId!, cols, rows });
    connecting.delete(paneId);
    const still = useApp.getState().findPane(paneId);
    if (!still) {
      void api().closeSession(res.sessionId);
      return;
    }
    useApp.getState().updatePane(paneId, { sessionId: res.sessionId });
    bindSession(res.sessionId, paneId);
    // локальные оболочки могут не прислать статус — считаем подключёнными сразу
    const after = useApp.getState().findPane(paneId);
    if (after && after.pane.status === 'connecting' && pane.kind === 'local') {
      useApp.getState().updatePane(paneId, { status: 'connected' });
    }
    // подогнать размер под реальный (если терминал успел измениться)
    const size = termSize(paneId);
    if (size.cols !== cols || size.rows !== rows) api().resize(res.sessionId, size.cols, size.rows);
  } catch (err) {
    connecting.delete(paneId);
    const message = errorText(err);
    useApp.getState().updatePane(paneId, { status: 'error', message });
    entry?.term.write(`\r\n\x1b[31m✗ ${message.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
  }
}

export async function reconnectPane(paneId: string) {
  const timer = reconnectTimers.get(paneId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(paneId);
  }
  const loc = useApp.getState().findPane(paneId);
  if (!loc) return;
  if (loc.pane.sessionId) {
    sessionToPane.delete(loc.pane.sessionId);
    void api().closeSession(loc.pane.sessionId).catch(() => undefined);
  }
  useApp.getState().updatePane(paneId, { sessionId: null, reconnectAttempt: 0 });
  getTerm(paneId)?.term.write('\r\n' + dim('— переподключение —') + '\r\n');
  await connectPane(paneId);
}

function releasePane(paneId: string) {
  const timer = reconnectTimers.get(paneId);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(paneId);
  const loc = useApp.getState().findPane(paneId);
  if (loc?.pane.sessionId) {
    sessionToPane.delete(loc.pane.sessionId);
    void api().closeSession(loc.pane.sessionId).catch(() => undefined);
  }
  disposeTerm(paneId);
}

function hasLiveSessions(paneIds: string[]): boolean {
  const st = useApp.getState();
  return paneIds.some((id) => {
    const loc = st.findPane(id);
    return loc && (loc.pane.status === 'connected' || loc.pane.status === 'connecting');
  });
}

/** Закрыть вкладку вместе с сессиями (с подтверждением, если включено). */
export function closeTab(tabId: string, force = false) {
  const st = useApp.getState();
  const tab = st.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const ids = tab.panes.map((p) => p.id);
  const doClose = () => {
    for (const id of ids) releasePane(id);
    useApp.getState().closeTab(tabId);
  };
  if (!force && st.settings().confirmCloseTab && hasLiveSessions(ids)) {
    st.setDialog({
      type: 'confirm',
      title: 'Закрыть вкладку?',
      text: `Сессия «${tab.title}» будет отключена.`,
      confirmLabel: 'Закрыть',
      danger: true,
      onConfirm: doClose,
    });
    return;
  }
  doClose();
}

export function closePane(paneId: string) {
  const loc = useApp.getState().findPane(paneId);
  if (!loc) return;
  if (loc.tab.panes.length <= 1) {
    closeTab(loc.tab.id);
    return;
  }
  releasePane(paneId);
  useApp.getState().closePane(paneId);
}

/** Открыть сервер: SSH — во вкладке, RDP — внешним клиентом. */
export async function openServer(server: Server, opts?: { sftp?: boolean; tool?: 'monitor' | 'tunnels'; reuse?: boolean }) {
  const st = useApp.getState();
  if (server.protocol === 'rdp') {
    try {
      await api().openSession({ kind: 'rdp', serverId: server.id });
      toast(`Запускаю удалённый рабочий стол: ${server.name || server.hostname}`, 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    }
    return;
  }
  if (opts?.reuse || opts?.tool || opts?.sftp) {
    // уже есть подключённая вкладка этого сервера — используем её
    for (const tab of st.tabs) {
      if (tab.serverId !== server.id) continue;
      const pane = tab.panes.find((p) => p.status === 'connected' && p.sessionId);
      if (!pane) continue;
      st.activateTab(tab.id);
      if (opts?.sftp && !tab.sftpOpen) st.toggleSftp(tab.id);
      if (opts?.tool && pane.sessionId) st.setDialog({ type: opts.tool, sessionId: pane.sessionId, serverId: server.id });
      return;
    }
  }
  st.openServerTab(server, { sftp: opts?.sftp ?? (server.followTerminalFolder !== false), tool: opts?.tool });
}

export function openShellById(shellId?: string | null) {
  const st = useApp.getState();
  const shells = st.shells;
  if (shells.length === 0) {
    toast('Локальные оболочки не найдены', 'error');
    return;
  }
  const shell = shells.find((s) => s.id === (shellId ?? st.settings().defaultShellID)) ?? shells[0];
  st.openShellTab(shell);
}

/** Активная панель (для вставки сниппетов, копирования и т.д.). */
export function activePaneId(): string | null {
  return activeLocation()?.pane.id ?? null;
}

export function sendToPane(paneId: string | null, text: string) {
  if (!paneId) {
    toast('Нет активного терминала', 'error');
    return;
  }
  const loc = useApp.getState().findPane(paneId);
  if (!loc?.pane.sessionId || loc.pane.status !== 'connected') {
    toast('Терминал не подключён', 'error');
    return;
  }
  api().write(loc.pane.sessionId, text);
  getTerm(paneId)?.term.focus();
}

export function pasteToPane(paneId: string | null) {
  if (!paneId) return;
  const text = api().clipboardRead();
  if (!text) return;
  const entry = getTerm(paneId);
  // paste() сам оборачивает текст в bracketed paste и отдаёт его в onData
  entry?.term.paste(text);
}

export function copyFromPane(paneId: string | null): boolean {
  if (!paneId) return false;
  const entry = getTerm(paneId);
  if (!entry?.term.hasSelection()) return false;
  api().clipboardWrite(entry.term.getSelection());
  return true;
}
