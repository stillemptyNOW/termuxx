import React, { useRef, useState } from 'react';
import {
  ChevronDown, Command, Copy, Gauge, House, Layers, Minus, PanelLeft, Plus, RefreshCw, Server, Settings, Square,
  SquareSplitHorizontal, SquareSplitVertical, SquareTerminal, Waypoints, X, Zap, FolderOpen,
} from 'lucide-react';
import type { Tab } from '../state';
import { useApp } from '../state';
import { cx, openMenu } from '../ui/kit';
import { closeTab, openServer, openShellById, reconnectPane } from './sessions';

function tabStatus(tab: Tab): 'ok' | 'warn' | 'err' | 'off' {
  if (tab.panes.some((p) => p.status === 'connected')) return 'ok';
  if (tab.panes.some((p) => p.status === 'connecting' || p.status === 'idle')) return 'warn';
  if (tab.panes.some((p) => p.status === 'error' || (p.status === 'closed' && p.dropped))) return 'err';
  return 'off';
}

function TabItem({ tab, active, index }: { tab: Tab; active: boolean; index: number }) {
  const activateTab = useApp((s) => s.activateTab);
  const moveTab = useApp((s) => s.moveTab);
  const multiExec = useApp((s) => s.multiExec);
  const setTabFlag = useApp((s) => s.setTabFlag);
  const server = useApp((s) => s.server(tab.serverId));
  const [dragOver, setDragOver] = useState(false);
  const status = tabStatus(tab);
  const activePane = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0];
  const oscTitle = activePane?.title;

  const menu = (e: React.MouseEvent) => {
    const st = useApp.getState();
    const sessionPane = tab.panes.find((p) => p.status === 'connected' && p.sessionId);
    openMenu(e, [
      {
        label: 'Дублировать вкладку', icon: <Copy size={14} />, onClick: () => {
          if (server) void openServer(server);
          else openShellById(tab.shellId);
        },
      },
      { label: 'Разделить вертикально', icon: <SquareSplitHorizontal size={14} />, onClick: () => { st.activateTab(tab.id); st.splitActive('row'); } },
      { label: 'Разделить горизонтально', icon: <SquareSplitVertical size={14} />, onClick: () => { st.activateTab(tab.id); st.splitActive('column'); } },
      ...(tab.kind === 'ssh' && server ? [
        { separator: true },
        { label: tab.sftpOpen ? 'Скрыть SFTP-панель' : 'Показать SFTP-панель', icon: <FolderOpen size={14} />, shortcut: 'Ctrl+Shift+B', onClick: () => st.toggleSftp(tab.id) },
        {
          label: 'Мониторинг сервера', icon: <Gauge size={14} />, disabled: !sessionPane,
          onClick: () => sessionPane?.sessionId && st.setDialog({ type: 'monitor', sessionId: sessionPane.sessionId, serverId: server.id }),
        },
        {
          label: 'Туннели', icon: <Waypoints size={14} />, disabled: !sessionPane,
          onClick: () => sessionPane?.sessionId && st.setDialog({ type: 'tunnels', sessionId: sessionPane.sessionId, serverId: server.id }),
        },
      ] : []),
      { separator: true },
      { label: 'Переподключить', icon: <RefreshCw size={14} />, onClick: () => tab.panes.forEach((p) => void reconnectPane(p.id)) },
      { label: 'Закрыть другие вкладки', onClick: () => st.tabs.filter((t) => t.id !== tab.id).forEach((t) => closeTab(t.id, true)) },
      { label: 'Закрыть', icon: <X size={14} />, shortcut: 'Ctrl+Shift+W', danger: true, onClick: () => closeTab(tab.id) },
    ]);
  };

  return (
    <div
      className={cx('tx-tab no-drag', active && 'active', tab.bell && 'bell', dragOver && 'drag-over')}
      title={[tab.title, oscTitle && oscTitle !== tab.title ? oscTitle : null, index < 9 ? `Ctrl+${index + 1}` : null].filter(Boolean).join('\n')}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/x-termuxx-tab', tab.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/x-termuxx-tab')) { e.preventDefault(); setDragOver(true); }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const from = e.dataTransfer.getData('text/x-termuxx-tab');
        if (from) { e.preventDefault(); moveTab(from, tab.id); }
      }}
      onMouseDown={(e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }
      }}
      onClick={() => activateTab(tab.id)}
      onContextMenu={menu}
    >
      {multiExec && (
        <input
          type="checkbox"
          className="tx-tab-check"
          checked={tab.multiExec}
          title="Отправлять ввод MultiExec в эту вкладку"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setTabFlag(tab.id, { multiExec: e.target.checked })}
        />
      )}
      <span className="tx-tab-icon" style={server ? { color: server.colorHex } : undefined}>
        {tab.kind === 'ssh' ? <Server size={14} /> : <SquareTerminal size={14} />}
        <span className={`dot ${status}`} />
      </span>
      <span className="tx-tab-title ellipsis">{tab.title}</span>
      {tab.panes.length > 1 && <span className="tx-tab-count">{tab.panes.length}</span>}
      <button
        className="tx-tab-close"
        title="Закрыть вкладку"
        onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function TitleBar() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const activateTab = useApp((s) => s.activateTab);
  const shells = useApp((s) => s.shells);
  const multiExec = useApp((s) => s.multiExec);
  const setMultiExec = useApp((s) => s.setMultiExec);
  const setDialog = useApp((s) => s.setDialog);
  const sidebarCollapsed = useApp((s) => s.layout.sidebarCollapsed);
  const setLayout = useApp((s) => s.setLayout);
  const maximized = useApp((s) => s.windowState.maximized);
  const stripRef = useRef<HTMLDivElement>(null);
  const isWin = window.termuxx.platform === 'win32';
  const isMac = window.termuxx.platform === 'darwin';

  const newTabMenu = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, [
      ...shells.map((sh, i) => ({
        label: sh.name,
        icon: <SquareTerminal size={14} />,
        shortcut: i === 0 ? 'Ctrl+Shift+T' : undefined,
        onClick: () => useApp.getState().openShellTab(sh),
      })),
      ...(shells.length ? [{ separator: true }] : []),
      { label: 'Быстрое подключение…', icon: <Zap size={14} />, onClick: () => focusQuickConnect() },
      { label: 'Новый сервер…', icon: <Plus size={14} />, shortcut: 'Ctrl+Shift+N', onClick: () => setDialog({ type: 'server' }) },
      { label: 'Палитра команд…', icon: <Command size={14} />, shortcut: 'Ctrl+Shift+P', onClick: () => setDialog({ type: 'palette' }) },
    ]);
  };

  return (
    <div className={cx('tx-titlebar drag', isWin && 'tx-titlebar-win', isMac && 'tx-titlebar-mac')}>
      <div className="tx-titlebar-left no-drag">
        <button
          className={cx('icon-btn', !sidebarCollapsed && 'active')}
          title="Панель сессий (Ctrl+Shift+S)"
          onClick={() => setLayout({ sidebarCollapsed: !sidebarCollapsed })}
        >
          <PanelLeft size={16} />
        </button>
        <button
          className={cx('icon-btn', activeTabId === null && 'active')}
          title="Главная"
          onClick={() => activateTab(null)}
        >
          <House size={16} />
        </button>
      </div>

      <div
        ref={stripRef}
        className="tx-tabstrip"
        onWheel={(e) => { if (stripRef.current) stripRef.current.scrollLeft += e.deltaY + e.deltaX; }}
      >
        {tabs.map((tab, i) => (
          <TabItem key={tab.id} tab={tab} index={i} active={tab.id === activeTabId} />
        ))}
        <div className="tx-newtab no-drag">
          <button className="icon-btn" title="Новая вкладка (Ctrl+Shift+T)" onClick={() => openShellById(null)}>
            <Plus size={16} />
          </button>
          <button className="icon-btn tx-newtab-more" title="Оболочки и подключения" onClick={newTabMenu}>
            <ChevronDown size={14} />
          </button>
        </div>
      </div>

      <div className="tx-titlebar-right no-drag">
        {tabs.length > 1 && (
          <button
            className={cx('tx-multiexec', multiExec && 'on')}
            title="MultiExec: ввод отправляется во все отмеченные вкладки"
            onClick={() => setMultiExec(!multiExec)}
          >
            <Layers size={14} />
            <span>MultiExec</span>
          </button>
        )}
        <button className="icon-btn" title="Палитра команд (Ctrl+Shift+P)" onClick={() => setDialog({ type: 'palette' })}>
          <Command size={16} />
        </button>
        <button className="icon-btn" title="Настройки" onClick={() => setDialog({ type: 'settings' })}>
          <Settings size={16} />
        </button>
        {!isWin && !isMac && (
          <div className="tx-winctl">
            <button title="Свернуть" onClick={() => window.termuxx.windowControl('minimize')}><Minus size={15} /></button>
            <button title={maximized ? 'Восстановить' : 'Развернуть'} onClick={() => window.termuxx.windowControl('maximize')}>
              {maximized ? <Copy size={13} /> : <Square size={13} />}
            </button>
            <button className="close" title="Закрыть" onClick={() => window.termuxx.windowControl('close')}><X size={16} /></button>
          </div>
        )}
        {isWin && <div className="tx-winctl-space" />}
      </div>
    </div>
  );
}

export function focusQuickConnect() {
  const st = useApp.getState();
  if (st.layout.sidebarCollapsed) st.setLayout({ sidebarCollapsed: false });
  setTimeout(() => {
    const home = document.getElementById('tx-home-quick') as HTMLInputElement | null;
    const el = home && home.offsetParent !== null
      ? home
      : (document.getElementById('tx-quick-input') as HTMLInputElement | null);
    el?.focus();
    el?.select();
  }, 30);
}
