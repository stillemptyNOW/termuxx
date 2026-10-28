import React, { useMemo, useState } from 'react';
import { Archive, ArrowRight, Clock, Import, KeyRound, Monitor, Plus, Server as ServerIcon, Settings, SquareTerminal, Zap } from 'lucide-react';
import type { Server } from '../../shared/types';
import { useApp } from '../state';
import { quickConnect, importPutty, importSshConfig } from './actions';
import { openServer, openShellById } from './sessions';
import { serverMenu } from './Sidebar';

function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'вчера' : `${d} дн назад`;
}

function RecentCard({ server }: { server: Server }) {
  const isRdp = server.protocol === 'rdp';
  return (
    <button
      className="tx-home-card"
      onClick={() => void openServer(server)}
      onContextMenu={(e) => serverMenu(e, server)}
      title={`${server.username}@${server.hostname}:${server.port}`}
    >
      <div className="tx-home-card-icon" style={{ background: server.colorHex }}>
        {isRdp ? <Monitor size={16} /> : <ServerIcon size={16} />}
      </div>
      <div className="tx-home-card-text">
        <div className="ellipsis tx-home-card-title">{server.name || server.hostname}</div>
        <div className="ellipsis mono faint">{server.username}@{server.hostname}</div>
      </div>
      <div className="tx-home-card-meta faint">{timeAgo(server.lastConnected)}</div>
    </button>
  );
}

export function Home() {
  const hosts = useApp((s) => s.data?.hosts) ?? [];
  const shells = useApp((s) => s.shells);
  const recentQuick = useApp((s) => s.layout.recentQuick);
  const setDialog = useApp((s) => s.setDialog);
  const [quick, setQuick] = useState('');

  const recent = useMemo(() => {
    const withTime = hosts.filter((h) => h.lastConnected)
      .sort((a, b) => Date.parse(b.lastConnected ?? '') - Date.parse(a.lastConnected ?? ''));
    const rest = hosts.filter((h) => !h.lastConnected);
    return [...withTime, ...rest].slice(0, 8);
  }, [hosts]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (quick.trim() && await quickConnect(quick)) setQuick('');
  };

  return (
    <div className="tx-home">
      <div className="tx-home-glow" />
      <div className="tx-home-inner">
        <div className="tx-home-hero">
          <div className="tx-logo">
            <span className="tx-logo-chevron">&gt;</span><span className="tx-logo-xx">xx</span><span className="tx-logo-cursor" />
          </div>
          <div>
            <h1>Termuxx</h1>
            <div className="muted">SSH, SFTP и терминал — всё в одном окне</div>
          </div>
        </div>

        <form className="tx-home-quick glass" onSubmit={submit}>
          <Zap size={18} className="tx-accent-icon" />
          <input
            id="tx-home-quick"
            list="tx-home-recent"
            autoFocus
            placeholder="Быстрое подключение: user@host:port"
            value={quick}
            spellCheck={false}
            onChange={(e) => setQuick(e.target.value)}
          />
          <datalist id="tx-home-recent">
            {recentQuick.map((r) => <option key={r} value={r} />)}
          </datalist>
          <button className="btn primary" type="submit" disabled={!quick.trim()}>
            Подключиться <ArrowRight size={14} />
          </button>
        </form>

        <div className="tx-home-actions">
          <button className="tx-home-action" onClick={() => setDialog({ type: 'server' })}>
            <Plus size={18} /><span>Новый сервер</span><small>SSH или RDP</small>
          </button>
          <button className="tx-home-action" onClick={() => openShellById(null)}>
            <SquareTerminal size={18} /><span>Локальный терминал</span><small>{shells[0]?.name ?? 'Оболочка'} · Ctrl+Shift+T</small>
          </button>
          <button className="tx-home-action" onClick={() => void importSshConfig()}>
            <Import size={18} /><span>Импорт ~/.ssh/config</span><small>Перенести хосты</small>
          </button>
          {window.termuxx.platform === 'win32' ? (
            <button className="tx-home-action" onClick={() => void importPutty()}>
              <Import size={18} /><span>Импорт из PuTTY</span><small>Сохранённые сессии</small>
            </button>
          ) : (
            <button className="tx-home-action" onClick={() => setDialog({ type: 'settings', section: 'keys' })}>
              <KeyRound size={18} /><span>SSH-ключи</span><small>Создать или импортировать</small>
            </button>
          )}
          <button className="tx-home-action" onClick={() => setDialog({ type: 'settings', section: 'backup' })}>
            <Archive size={18} /><span>Бэкап с iPhone</span><small>Termuxx для iOS и Linux</small>
          </button>
        </div>

        {recent.length > 0 && (
          <section>
            <div className="tx-home-section"><Clock size={14} /> Недавние серверы</div>
            <div className="tx-home-grid">
              {recent.map((s) => <RecentCard key={s.id} server={s} />)}
            </div>
          </section>
        )}

        {shells.length > 0 && (
          <section>
            <div className="tx-home-section"><SquareTerminal size={14} /> Локальные оболочки</div>
            <div className="tx-home-shells">
              {shells.map((sh) => (
                <button key={sh.id} className="tx-chip" onClick={() => openShellById(sh.id)}>
                  <SquareTerminal size={13} /> {sh.name}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="tx-home-hints faint">
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> палитра команд</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> новая вкладка</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> разделить</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> SFTP</span>
          <button className="btn ghost small" onClick={() => setDialog({ type: 'settings' })}><Settings size={13} /> Настройки</button>
        </div>
      </div>
    </div>
  );
}
