import React, { useCallback, useRef } from 'react';
import type { Tab } from '../state';
import { useApp } from '../state';
import { SftpPanel } from '../tools';
import { TerminalPane } from './TerminalPane';

/** Вертикальный разделитель, меняющий ширину соседней панели. */
export function Resizer({ onResize, side = 'right' }: { onResize: (dx: number) => void; side?: 'left' | 'right' }) {
  const last = useRef(0);
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    last.current = e.clientX;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - last.current;
      last.current = ev.clientX;
      onResize(side === 'right' ? dx : -dx);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('tx-resizing');
    };
    document.body.classList.add('tx-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [onResize, side]);
  return <div className="tx-resizer" onMouseDown={onMouseDown} />;
}

export function TabView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const server = useApp((s) => s.server(tab.serverId));
  const sftpWidth = useApp((s) => s.layout.sftpWidth);
  const setLayout = useApp((s) => s.setLayout);
  const toggleSftp = useApp((s) => s.toggleSftp);
  const followDefault = useApp((s) => s.data?.settings.sftpFollowsTerminal ?? true);

  // SFTP-панель следует за активной (или первой подключённой) SSH-панелью вкладки
  const activePane = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0];
  const sftpPane = activePane?.status === 'connected' && activePane.sessionId
    ? activePane
    : tab.panes.find((p) => p.status === 'connected' && p.sessionId) ?? activePane;
  const showSftp = tab.kind === 'ssh' && tab.sftpOpen && !!server;

  const widthRef = useRef(sftpWidth);
  widthRef.current = sftpWidth;
  const onResize = useCallback((dx: number) => {
    const next = Math.max(220, Math.min(640, widthRef.current + dx));
    widthRef.current = next;
    setLayout({ sftpWidth: next });
  }, [setLayout]);

  return (
    <div className="tx-tabview" style={{ display: visible ? 'flex' : 'none' }}>
      {showSftp && server && (
        <>
          <div className="tx-sftp-dock" style={{ width: sftpWidth }}>
            <SftpPanel
              sessionId={sftpPane?.sessionId ?? ''}
              server={server}
              connected={sftpPane?.status === 'connected' && !!sftpPane.sessionId}
              onClose={() => toggleSftp(tab.id)}
              followDefault={followDefault}
            />
          </div>
          <Resizer onResize={onResize} />
        </>
      )}
      <div className={`tx-panes tx-split-${tab.split}`}>
        {tab.panes.map((pane) => (
          <TerminalPane key={pane.id} tab={tab} pane={pane} visible={visible} />
        ))}
      </div>
    </div>
  );
}
