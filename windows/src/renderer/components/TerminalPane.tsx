import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, CaseSensitive, CircleX, Clipboard, Copy, Eraser, LoaderCircle, Plug, RefreshCw, Regex, Search,
  SquareSplitHorizontal, SquareSplitVertical, X,
} from 'lucide-react';
import { DEFAULT_SETTINGS } from '../../shared/types';
import type { Pane, Tab } from '../state';
import { useApp } from '../state';
import { attachTerm, ensureTerm, focusTerm, getTerm, scheduleFit } from './terminals';
import { closePane, copyFromPane, pasteToPane, reconnectPane } from './sessions';
import { Button, IconButton, openMenu } from '../ui/kit';

export function TerminalPane({ tab, pane, visible }: { tab: Tab; pane: Pane; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const settings = useApp((s) => s.data?.settings) ?? DEFAULT_SETTINGS;
  const searchOpen = useApp((s) => s.searchPaneId === pane.id);
  const focusPaneAction = useApp((s) => s.focusPane);
  const isActive = tab.activePaneId === pane.id;

  // Терминал создаётся один раз на панель и переживает перерисовки.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const entry = ensureTerm(pane.id, useApp.getState().settings());
    attachTerm(entry, host);
    const ro = new ResizeObserver(() => scheduleFit(pane.id));
    ro.observe(host);
    return () => ro.disconnect();
  }, [pane.id]);

  useEffect(() => {
    if (!visible) return;
    scheduleFit(pane.id);
    if (isActive && !useApp.getState().dialog) {
      const t = setTimeout(() => focusTerm(pane.id), 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [visible, isActive, pane.id, tab.panes.length, tab.split]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (settings.rightClickPaste && !e.shiftKey) {
      // PuTTY/MobaXterm: правая кнопка вставляет (если есть выделение без copy-on-select — копирует)
      if (!settings.copyOnSelect && copyFromPane(pane.id)) {
        getTerm(pane.id)?.term.clearSelection();
        return;
      }
      pasteToPane(pane.id);
      return;
    }
    const hasSel = !!getTerm(pane.id)?.term.hasSelection();
    openMenu(e, [
      { label: 'Копировать', icon: <Copy size={14} />, shortcut: 'Ctrl+Shift+C', disabled: !hasSel, onClick: () => copyFromPane(pane.id) },
      { label: 'Вставить', icon: <Clipboard size={14} />, shortcut: 'Ctrl+Shift+V', onClick: () => pasteToPane(pane.id) },
      { label: 'Найти…', icon: <Search size={14} />, shortcut: 'Ctrl+Shift+F', onClick: () => useApp.getState().setSearchPane(pane.id) },
      { label: 'Очистить экран', icon: <Eraser size={14} />, onClick: () => getTerm(pane.id)?.term.clear() },
      { separator: true },
      { label: 'Разделить вертикально', icon: <SquareSplitHorizontal size={14} />, shortcut: 'Ctrl+Shift+D', onClick: () => useApp.getState().splitActive('row') },
      { label: 'Разделить горизонтально', icon: <SquareSplitVertical size={14} />, shortcut: 'Ctrl+Shift+E', onClick: () => useApp.getState().splitActive('column') },
      { separator: true },
      { label: 'Переподключиться', icon: <RefreshCw size={14} />, onClick: () => void reconnectPane(pane.id) },
      ...(tab.panes.length > 1
        ? [{ label: 'Закрыть панель', icon: <X size={14} />, danger: true, onClick: () => closePane(pane.id) }]
        : []),
    ]);
  };

  return (
    <div
      className={`tx-pane${isActive && tab.panes.length > 1 ? ' tx-pane-active' : ''}`}
      onMouseDown={() => { if (!isActive) focusPaneAction(tab.id, pane.id); }}
      onContextMenu={onContextMenu}
    >
      <div ref={hostRef} className="tx-host" />
      {searchOpen && <FindBar paneId={pane.id} />}
      <PaneOverlay tab={tab} pane={pane} />
    </div>
  );
}

function PaneOverlay({ tab, pane }: { tab: Tab; pane: Pane }) {
  const server = useApp((s) => s.server(pane.serverId));
  if (pane.status === 'connecting' || pane.status === 'idle') {
    return (
      <div className="tx-pane-chip glass">
        <LoaderCircle size={14} className="tx-spin" />
        <span>{pane.kind === 'ssh' ? `Подключение к ${server?.hostname ?? 'серверу'}…` : 'Запуск оболочки…'}</span>
      </div>
    );
  }
  if (pane.status === 'closed' || pane.status === 'error') {
    const dropped = pane.dropped;
    const title = pane.status === 'error'
      ? 'Не удалось подключиться'
      : dropped ? 'Соединение потеряно' : 'Сессия завершена';
    return (
      <div className="tx-pane-banner glass">
        {pane.status === 'error' ? <CircleX size={18} color="var(--danger)" /> : <Plug size={18} color={dropped ? 'var(--warning)' : 'var(--text-secondary)'} />}
        <div className="col grow" style={{ gap: 2 }}>
          <strong>{title}</strong>
          {pane.message && <span className="muted ellipsis" title={pane.message}>{pane.message}</span>}
          <span className="faint" style={{ fontSize: 11 }}>Нажмите R или Enter в терминале, чтобы переподключиться</span>
        </div>
        <Button variant="primary" small icon={<RefreshCw size={13} />} onClick={() => void reconnectPane(pane.id)}>
          {pane.kind === 'ssh' ? 'Переподключить' : 'Перезапустить'}
        </Button>
        <IconButton title="Закрыть" onClick={() => closePane(pane.id)}><X size={15} /></IconButton>
      </div>
    );
  }
  void tab;
  return null;
}

function FindBar({ paneId }: { paneId: string }) {
  const [text, setText] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const setSearchPane = useApp((s) => s.setSearchPane);

  useEffect(() => {
    inputRef.current?.focus();
    const entry = getTerm(paneId);
    const sub = entry?.search.onDidChangeResults((e) => setResult({ index: e.resultIndex, count: e.resultCount }));
    return () => {
      sub?.dispose();
      getTerm(paneId)?.search.clearDecorations();
    };
  }, [paneId]);

  const opts = {
    regex,
    caseSensitive,
    decorations: {
      matchBackground: '#3DDC9733',
      matchOverviewRuler: '#3DDC97',
      activeMatchBackground: '#3DDC9799',
      activeMatchColorOverviewRuler: '#7AF0BC',
    },
  };
  const find = (dir: 1 | -1, incremental = false) => {
    const entry = getTerm(paneId);
    if (!entry || !text) return;
    try {
      if (dir === 1) entry.search.findNext(text, { ...opts, incremental });
      else entry.search.findPrevious(text, opts);
    } catch {
      /* неверное регулярное выражение */
    }
  };
  const close = () => {
    setSearchPane(null);
    focusTerm(paneId);
  };

  return (
    <div className="tx-find glass" onMouseDown={(e) => e.stopPropagation()}>
      <Search size={14} className="faint" />
      <input
        ref={inputRef}
        className="tx-find-input"
        placeholder="Найти в терминале"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const entry = getTerm(paneId);
          if (entry && e.target.value) {
            try { entry.search.findNext(e.target.value, { ...opts, incremental: true }); } catch { /* ок */ }
          } else {
            entry?.search.clearDecorations();
            setResult(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey ? -1 : 1); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        }}
      />
      <span className="faint tx-find-count">{result && text ? (result.count ? `${result.index + 1}/${result.count}` : '0') : ''}</span>
      <IconButton title="Учитывать регистр" active={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)}><CaseSensitive size={15} /></IconButton>
      <IconButton title="Регулярное выражение" active={regex} onClick={() => setRegex(!regex)}><Regex size={15} /></IconButton>
      <IconButton title="Предыдущее (Shift+Enter)" onClick={() => find(-1)}><ArrowUp size={15} /></IconButton>
      <IconButton title="Следующее (Enter)" onClick={() => find(1)}><ArrowDown size={15} /></IconButton>
      <IconButton title="Закрыть (Esc)" onClick={close}><X size={15} /></IconButton>
    </div>
  );
}
