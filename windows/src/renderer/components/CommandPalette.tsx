import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive, Command, FolderOpen, Gauge, House, Import, Layers, ListPlus, Maximize2, Palette, Plus, RefreshCw, Search,
  Server as ServerIcon, Settings, SquareSplitHorizontal, SquareSplitVertical, SquareTerminal, Waypoints, X,
} from 'lucide-react';
import { activeLocation, useApp } from '../state';
import { THEMES } from '../themes';
import { cx } from '../ui/kit';
import { activePaneId, closeTab, openServer, reconnectPane, sendToPane } from './sessions';
import { importPutty, importSshConfig } from './actions';
import { useSaveSettings } from './SettingsDialog';

interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  icon: React.ReactNode;
  keywords?: string;
  shortcut?: string;
  run: () => void;
}

function score(item: PaletteItem, words: string[]): number {
  if (words.length === 0) return 1;
  const hay = `${item.title} ${item.subtitle ?? ''} ${item.keywords ?? ''} ${item.group}`.toLowerCase();
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += i === 0 ? 3 : item.title.toLowerCase().includes(w) ? 2 : 1;
  }
  return s;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const saveSettings = useSaveSettings();

  const items = useMemo<PaletteItem[]>(() => {
    const st = useApp.getState();
    const loc = activeLocation(st);
    const data = st.data;
    const out: PaletteItem[] = [];
    for (const s of data?.hosts ?? []) {
      out.push({
        id: `srv-${s.id}`, group: 'Серверы', icon: <ServerIcon size={15} style={{ color: s.colorHex }} />,
        title: `Подключиться: ${s.name || s.hostname}`, subtitle: `${s.username}@${s.hostname}${s.port !== 22 ? `:${s.port}` : ''}`,
        keywords: `${s.group ?? ''} ssh ${s.protocol ?? ''}`, run: () => void openServer(s),
      });
    }
    for (const sh of st.shells) {
      out.push({ id: `sh-${sh.id}`, group: 'Оболочки', icon: <SquareTerminal size={15} />, title: `Открыть: ${sh.name}`, subtitle: sh.command, keywords: 'терминал shell', run: () => st.openShellTab(sh) });
    }
    for (const sn of data?.snippets ?? []) {
      out.push({
        id: `sn-${sn.id}`, group: 'Сниппеты', icon: <ListPlus size={15} />, title: `Сниппет: ${sn.name}`, subtitle: sn.command,
        run: () => sendToPane(activePaneId(), sn.command + (sn.runImmediately ? '\r' : '')),
      });
    }
    const actions: PaletteItem[] = [
      { id: 'a-new', group: 'Действия', icon: <Plus size={15} />, title: 'Новый сервер', shortcut: 'Ctrl+Shift+N', run: () => st.setDialog({ type: 'server' }) },
      { id: 'a-settings', group: 'Действия', icon: <Settings size={15} />, title: 'Настройки', keywords: 'параметры', run: () => st.setDialog({ type: 'settings' }) },
      { id: 'a-keys', group: 'Действия', icon: <Settings size={15} />, title: 'SSH-ключи', keywords: 'ключ key', run: () => st.setDialog({ type: 'settings', section: 'keys' }) },
      { id: 'a-backup', group: 'Действия', icon: <Archive size={15} />, title: 'Резервная копия: экспорт и импорт', keywords: 'бэкап backup', run: () => st.setDialog({ type: 'settings', section: 'backup' }) },
      { id: 'a-ssh-config', group: 'Действия', icon: <Import size={15} />, title: 'Импорт из ~/.ssh/config', run: () => void importSshConfig() },
      ...(window.termuxx.platform === 'win32'
        ? [{ id: 'a-putty', group: 'Действия', icon: <Import size={15} />, title: 'Импорт сессий PuTTY', run: () => void importPutty() }]
        : []),
      { id: 'a-home', group: 'Действия', icon: <House size={15} />, title: 'Главная', run: () => st.activateTab(null) },
      { id: 'a-full', group: 'Действия', icon: <Maximize2 size={15} />, title: 'Полноэкранный режим', shortcut: 'F11', run: () => window.termuxx.windowControl('fullscreen') },
    ];
    if (st.tabs.length > 1) {
      actions.push({ id: 'a-multi', group: 'Действия', icon: <Layers size={15} />, title: st.multiExec ? 'Выключить MultiExec' : 'Включить MultiExec', shortcut: 'Ctrl+Shift+M', keywords: 'все вкладки одновременно', run: () => st.setMultiExec(!st.multiExec) });
    }
    if (loc) {
      const { tab, pane } = loc;
      actions.push(
        { id: 'a-split-v', group: 'Вкладка', icon: <SquareSplitHorizontal size={15} />, title: 'Разделить вертикально', shortcut: 'Ctrl+Shift+D', run: () => st.splitActive('row') },
        { id: 'a-split-h', group: 'Вкладка', icon: <SquareSplitVertical size={15} />, title: 'Разделить горизонтально', shortcut: 'Ctrl+Shift+E', run: () => st.splitActive('column') },
        { id: 'a-find', group: 'Вкладка', icon: <Search size={15} />, title: 'Найти в терминале', shortcut: 'Ctrl+Shift+F', run: () => st.setSearchPane(pane.id) },
        { id: 'a-reconnect', group: 'Вкладка', icon: <RefreshCw size={15} />, title: 'Переподключить', run: () => void reconnectPane(pane.id) },
        { id: 'a-close', group: 'Вкладка', icon: <X size={15} />, title: 'Закрыть вкладку', shortcut: 'Ctrl+Shift+W', run: () => closeTab(tab.id) },
      );
      if (tab.kind === 'ssh' && tab.serverId) {
        const sid = pane.sessionId;
        actions.push({ id: 'a-sftp', group: 'Вкладка', icon: <FolderOpen size={15} />, title: tab.sftpOpen ? 'Скрыть SFTP-панель' : 'Показать SFTP-панель', shortcut: 'Ctrl+Shift+B', run: () => st.toggleSftp(tab.id) });
        if (sid && pane.status === 'connected') {
          actions.push(
            { id: 'a-monitor', group: 'Вкладка', icon: <Gauge size={15} />, title: 'Мониторинг сервера', keywords: 'cpu память диск', run: () => st.setDialog({ type: 'monitor', sessionId: sid, serverId: tab.serverId! }) },
            { id: 'a-tunnels', group: 'Вкладка', icon: <Waypoints size={15} />, title: 'Туннели', keywords: 'проброс портов forward', run: () => st.setDialog({ type: 'tunnels', sessionId: sid, serverId: tab.serverId! }) },
          );
        }
      }
    }
    for (const t of THEMES) {
      actions.push({ id: `theme-${t.id}`, group: 'Тема', icon: <Palette size={15} />, title: `Тема: ${t.name}`, keywords: 'оформление цвет', run: () => saveSettings({ themeID: t.id }) });
    }
    return [...out, ...actions];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items
      .map((item) => ({ item, s: score(item, words) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.item);
  }, [items, query]);

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    setTimeout(item.run, 0);
  };

  return createPortal(
    <div className="tx-palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tx-palette glass">
        <div className="tx-palette-input">
          <Command size={16} className="tx-accent-icon" />
          <input
            autoFocus
            placeholder="Сервер, оболочка, сниппет или команда…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(filtered.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(filtered[index]); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            }}
          />
          <kbd className="tx-kbd">Esc</kbd>
        </div>
        <div className="tx-palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="faint" style={{ padding: 16 }}>Ничего не найдено</div>}
          {filtered.map((item, i) => (
            <div
              key={item.id}
              data-idx={i}
              className={cx('tx-palette-item', i === index && 'on')}
              onMouseMove={() => setIndex(i)}
              onClick={() => run(item)}
            >
              <span className="tx-palette-icon">{item.icon}</span>
              <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
                <span className="ellipsis">{item.title}</span>
                {item.subtitle && <span className="faint mono ellipsis" style={{ fontSize: 11 }}>{item.subtitle}</span>}
              </div>
              {item.shortcut && <kbd className="tx-kbd">{item.shortcut}</kbd>}
              <span className="faint tx-palette-group">{item.group}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
