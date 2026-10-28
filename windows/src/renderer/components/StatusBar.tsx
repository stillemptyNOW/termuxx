import React from 'react';
import { FolderOpen, Layers, ListPlus, Server as ServerIcon, SquareTerminal, Waypoints } from 'lucide-react';
import { activeLocation, useApp } from '../state';
import { cx, openMenu } from '../ui/kit';
import { MonitorBar } from '../tools';
import { sendToPane } from './sessions';
import { themeById } from '../themes';

const STATUS_TEXT: Record<string, string> = {
  idle: 'ожидание',
  connecting: 'подключение…',
  connected: 'подключено',
  closed: 'отключено',
  error: 'ошибка',
};

export function StatusBar() {
  const loc = useApp((s) => activeLocation(s));
  const server = useApp((s) => s.server(loc?.pane.serverId));
  const shell = useApp((s) => s.shells.find((sh) => sh.id === loc?.pane.shellId));
  const settings = useApp((s) => s.data?.settings);
  const snippets = useApp((s) => s.data?.snippets) ?? [];
  const multiExec = useApp((s) => s.multiExec);
  const toggleSftp = useApp((s) => s.toggleSftp);
  const setDialog = useApp((s) => s.setDialog);

  const tab = loc?.tab;
  const pane = loc?.pane;
  const connected = pane?.status === 'connected' && !!pane.sessionId;

  const snippetMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ clientX: r.left, clientY: r.top }, [
      ...snippets.map((s) => ({
        label: s.name,
        onClick: () => sendToPane(pane?.id ?? null, s.command + (s.runImmediately ? '\r' : '')),
      })),
      ...(snippets.length ? [{ separator: true }] : []),
      { label: 'Управление сниппетами…', icon: <ListPlus size={14} />, onClick: () => setDialog({ type: 'settings', section: 'snippets' }) },
    ]);
  };

  return (
    <footer className="tx-statusbar">
      <div className="tx-status-left">
        {tab && pane ? (
          <>
            <span className="tx-status-item" title={STATUS_TEXT[pane.status]}>
              <span className={cx('dot', pane.status === 'connected' ? 'ok' : pane.status === 'error' ? 'err' : pane.status === 'closed' ? 'off' : 'warn')} />
              {tab.kind === 'ssh' ? <ServerIcon size={12} /> : <SquareTerminal size={12} />}
              <span className="mono ellipsis">
                {tab.kind === 'ssh' && server ? `${server.username}@${server.hostname}${server.port !== 22 ? `:${server.port}` : ''}` : shell?.name ?? tab.title}
              </span>
              <span className="faint">· {STATUS_TEXT[pane.status]}</span>
            </span>
            {tab.kind === 'ssh' && (
              <button className={cx('tx-status-btn', tab.sftpOpen && 'on')} title="SFTP-панель (Ctrl+Shift+B)" onClick={() => toggleSftp(tab.id)}>
                <FolderOpen size={12} /> SFTP
              </button>
            )}
            {tab.kind === 'ssh' && server && connected && (
              <button className="tx-status-btn" title="Туннели" onClick={() => setDialog({ type: 'tunnels', sessionId: pane.sessionId!, serverId: server.id })}>
                <Waypoints size={12} /> {server.forwards.length || ''}
              </button>
            )}
            <button className="tx-status-btn" title="Сниппеты" onClick={snippetMenu}>
              <ListPlus size={12} /> Сниппеты
            </button>
          </>
        ) : (
          <span className="tx-status-item faint">Termuxx · главная</span>
        )}
        {multiExec && <span className="tx-status-item tx-status-multi"><Layers size={12} /> MultiExec</span>}
      </div>
      <div className="tx-status-right">
        {tab?.kind === 'ssh' && server && connected && settings?.showRemoteMonitorBar !== false && (
          <MonitorBar
            sessionId={pane!.sessionId!}
            onOpenDashboard={() => setDialog({ type: 'monitor', sessionId: pane!.sessionId!, serverId: server.id })}
          />
        )}
        {settings && <span className="tx-status-item faint">{themeById(settings.themeID).name} · {settings.fontSize}px · UTF-8</span>}
      </div>
    </footer>
  );
}
