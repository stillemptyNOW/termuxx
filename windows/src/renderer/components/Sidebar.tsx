import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, Copy, Ellipsis, Folder, FolderInput, FolderOpen, Gauge, Import, KeyRound, Lock, Monitor,
  Pencil, Play, Plus, Route, Search, Server as ServerIcon, Shield, SquareTerminal, Trash, Waypoints, Zap, Archive,
} from 'lucide-react';
import type { Server } from '../../shared/types';
import { useApp } from '../state';
import { cx, openMenu } from '../ui/kit';
import { Resizer } from './Workspace';
import { openServer, openShellById } from './sessions';
import {
  askFolder, confirmDeleteServer, copySshCommand, duplicateServer, importPutty, importSshConfig, moveServerToGroup, quickConnect,
} from './actions';

export function serverMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, server: Server) {
  const st = useApp.getState();
  const isRdp = server.protocol === 'rdp';
  openMenu(e, [
    { label: isRdp ? 'Подключиться (RDP)' : 'Подключиться', icon: <Play size={14} />, onClick: () => void openServer(server) },
    ...(!isRdp ? [
      { label: 'Открыть SFTP', icon: <FolderOpen size={14} />, onClick: () => void openServer(server, { sftp: true, reuse: true }) },
      { label: 'Мониторинг', icon: <Gauge size={14} />, onClick: () => void openServer(server, { tool: 'monitor', reuse: true }) },
      { label: 'Туннели', icon: <Waypoints size={14} />, onClick: () => void openServer(server, { tool: 'tunnels', reuse: true }) },
    ] : []),
    { separator: true },
    { label: 'Изменить…', icon: <Pencil size={14} />, onClick: () => st.setDialog({ type: 'server', serverId: server.id }) },
    { label: 'Дублировать', icon: <Copy size={14} />, onClick: () => void duplicateServer(server) },
    { label: 'Переместить в папку…', icon: <FolderInput size={14} />, onClick: () => askFolder(server) },
    ...(!isRdp ? [{ label: 'Копировать команду ssh', icon: <SquareTerminal size={14} />, onClick: () => copySshCommand(server) }] : []),
    { separator: true },
    { label: 'Удалить', icon: <Trash size={14} />, danger: true, onClick: () => confirmDeleteServer(server) },
  ]);
}

export function importMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }) {
  const st = useApp.getState();
  openMenu(e, [
    { label: 'Импорт из ~/.ssh/config', icon: <Import size={14} />, onClick: () => void importSshConfig() },
    ...(window.termuxx.platform === 'win32'
      ? [{ label: 'Импорт сессий PuTTY', icon: <Import size={14} />, onClick: () => void importPutty() }]
      : []),
    { label: 'Восстановить из бэкапа Termuxx…', icon: <Archive size={14} />, onClick: () => st.setDialog({ type: 'settings', section: 'backup' }) },
    { separator: true },
    { label: 'Экспорт бэкапа…', icon: <Archive size={14} />, onClick: () => st.setDialog({ type: 'settings', section: 'backup' }) },
  ]);
}

function ServerRow({ server, selected, onSelect }: { server: Server; selected: boolean; onSelect: () => void }) {
  const connected = useApp((s) => s.tabs.some((t) => t.serverId === server.id && t.panes.some((p) => p.status === 'connected')));
  const isRdp = server.protocol === 'rdp';
  const initials = (server.name || server.hostname).trim().slice(0, 2).toUpperCase();
  return (
    <div
      className={cx('tx-srv', selected && 'selected')}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/x-termuxx-server', server.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={onSelect}
      onDoubleClick={() => void openServer(server)}
      onContextMenu={(e) => { onSelect(); serverMenu(e, server); }}
      title={`${server.username}@${server.hostname}:${server.port}${server.notes ? `\n${server.notes}` : ''}\nДвойной щелчок — подключиться`}
    >
      <div className="tx-srv-badge" style={{ background: server.colorHex }}>
        {isRdp ? <Monitor size={14} /> : <span>{initials}</span>}
      </div>
      <div className="tx-srv-text">
        <div className="tx-srv-name ellipsis">{server.name || server.hostname}</div>
        <div className="tx-srv-sub ellipsis mono">{server.username}@{server.hostname}{server.port !== (isRdp ? 3389 : 22) ? `:${server.port}` : ''}</div>
      </div>
      <div className="tx-srv-flags">
        {connected && <span className="dot ok" title="Подключено" />}
        {isRdp && <span className="badge">RDP</span>}
        {server.jumpHostID && <span title="Через промежуточный сервер"><Route size={12} /></span>}
        {server.proxy && <span title="Через SOCKS5-прокси"><Shield size={12} /></span>}
        {server.forwards.length > 0 && <span title={`Туннели: ${server.forwards.length}`}><Waypoints size={12} /></span>}
        {!isRdp && (server.auth === 'key' ? <span title="Вход по ключу"><KeyRound size={12} /></span> : server.auth === 'password' ? <span title="Вход по паролю"><Lock size={12} /></span> : null)}
      </div>
    </div>
  );
}

function FolderBlock({ name, servers, selectedId, onSelect }: {
  name: string; servers: Server[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const collapsed = useApp((s) => s.layout.collapsedGroups.includes(name));
  const setLayout = useApp((s) => s.setLayout);
  const [over, setOver] = useState(false);
  const toggle = () => {
    const groups = useApp.getState().layout.collapsedGroups;
    setLayout({ collapsedGroups: collapsed ? groups.filter((g) => g !== name) : [...groups, name] });
  };
  return (
    <div className={cx('tx-folder', over && 'drop')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-termuxx-server')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData('text/x-termuxx-server');
        const server = useApp.getState().server(id);
        if (server) { e.preventDefault(); e.stopPropagation(); void moveServerToGroup(server, name); }
      }}
    >
      <div className="tx-folder-head" onClick={toggle}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        {collapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
        <span className="grow ellipsis">{name}</span>
        <span className="faint">{servers.length}</span>
      </div>
      {!collapsed && (
        <div className="tx-folder-body">
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} selected={selectedId === s.id} onSelect={() => onSelect(s.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const hosts = useApp((s) => s.data?.hosts) ?? [];
  const shells = useApp((s) => s.shells);
  const width = useApp((s) => s.layout.sidebarWidth);
  const recentQuick = useApp((s) => s.layout.recentQuick);
  const setLayout = useApp((s) => s.setLayout);
  const setDialog = useApp((s) => s.setDialog);
  const [search, setSearch] = useState('');
  const [quick, setQuick] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rootOver, setRootOver] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const onResize = useCallback((dx: number) => {
    const next = Math.max(200, Math.min(480, widthRef.current + dx));
    widthRef.current = next;
    setLayout({ sidebarWidth: next });
  }, [setLayout]);

  const { ungrouped, groups } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = hosts
      .filter((h) => !q || [h.name, h.hostname, h.username, h.group ?? '', h.notes ?? ''].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => (a.name || a.hostname).localeCompare(b.name || b.hostname, 'ru'));
    const map = new Map<string, Server[]>();
    const root: Server[] = [];
    for (const h of list) {
      if (h.group) {
        const arr = map.get(h.group) ?? [];
        arr.push(h);
        map.set(h.group, arr);
      } else {
        root.push(h);
      }
    }
    return { ungrouped: root, groups: [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru')) };
  }, [hosts, search]);

  const submitQuick = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quick.trim()) return;
    if (await quickConnect(quick)) setQuick('');
  };

  return (
    <>
      <aside className="tx-sidebar" style={{ width }}>
        <div className="tx-side-head">
          <span className="tx-side-title">Сессии</span>
          <button className="icon-btn" title="Новый сервер (Ctrl+Shift+N)" onClick={() => setDialog({ type: 'server' })}><Plus size={16} /></button>
          <button className="icon-btn" title="Импорт и экспорт" onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            importMenu({ clientX: r.left, clientY: r.bottom + 4 });
          }}><Ellipsis size={16} /></button>
        </div>

        <form className="tx-side-quick" onSubmit={submitQuick}>
          <Zap size={14} className="tx-accent-icon" />
          <input
            id="tx-quick-input"
            list="tx-quick-recent"
            placeholder="user@host:port — Enter"
            value={quick}
            spellCheck={false}
            onChange={(e) => setQuick(e.target.value)}
          />
          <datalist id="tx-quick-recent">
            {recentQuick.map((r) => <option key={r} value={r} />)}
          </datalist>
        </form>

        <div className="tx-side-search">
          <Search size={14} className="faint" />
          <input placeholder="Поиск серверов" value={search} spellCheck={false} onChange={(e) => setSearch(e.target.value)} />
        </div>

        <div
          className={cx('tx-side-list', rootOver && 'drop')}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-termuxx-server')) { e.preventDefault(); setRootOver(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setRootOver(false); }}
          onDrop={(e) => {
            setRootOver(false);
            const id = e.dataTransfer.getData('text/x-termuxx-server');
            const server = useApp.getState().server(id);
            if (server) { e.preventDefault(); void moveServerToGroup(server, null); }
          }}
        >
          {hosts.length === 0 && (
            <div className="tx-side-empty">
              <ServerIcon size={28} className="faint" />
              <div>Серверов пока нет</div>
              <button className="btn small primary" onClick={() => setDialog({ type: 'server' })}><Plus size={13} /> Добавить сервер</button>
              <button className="btn small" onClick={() => void importSshConfig()}><Import size={13} /> Импорт из ~/.ssh/config</button>
            </div>
          )}
          {hosts.length > 0 && ungrouped.length === 0 && groups.length === 0 && (
            <div className="tx-side-empty faint">Ничего не найдено</div>
          )}
          {ungrouped.map((s) => (
            <ServerRow key={s.id} server={s} selected={selectedId === s.id} onSelect={() => setSelectedId(s.id)} />
          ))}
          {groups.map(([name, list]) => (
            <FolderBlock key={name} name={name} servers={list} selectedId={selectedId} onSelect={setSelectedId} />
          ))}

          {shells.length > 0 && !search && (
            <>
              <div className="section-title">Локальные оболочки</div>
              {shells.map((sh) => (
                <div key={sh.id} className="tx-srv tx-shell" onDoubleClick={() => openShellById(sh.id)} title="Двойной щелчок — открыть">
                  <div className="tx-srv-badge tx-shell-badge"><SquareTerminal size={14} /></div>
                  <div className="tx-srv-text">
                    <div className="tx-srv-name ellipsis">{sh.name}</div>
                    <div className="tx-srv-sub ellipsis mono">{sh.command}</div>
                  </div>
                  <button className="icon-btn tx-shell-open" title="Открыть" onClick={() => openShellById(sh.id)}><Play size={13} /></button>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="tx-side-foot faint">
          {hosts.length} {hosts.length % 10 === 1 && hosts.length % 100 !== 11 ? 'сервер' : (hosts.length % 10 >= 2 && hosts.length % 10 <= 4 && (hosts.length % 100 < 12 || hosts.length % 100 > 14)) ? 'сервера' : 'серверов'}
          {groups.length > 0 && ` · ${groups.length} ${groups.length === 1 ? 'папка' : groups.length < 5 ? 'папки' : 'папок'}`}
        </div>
      </aside>
      <Resizer onResize={onResize} />
    </>
  );
}
