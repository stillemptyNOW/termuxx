// SFTP-панель рядом с терминалом (как в MobaXterm): работает поверх SSH-подключения активной вкладки.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Copy, Download, Eye, EyeOff, ExternalLink, File as FileIcon, FileArchive, FileAudio, FileCode2, FileCog,
  FileImage, FileKey, FilePlus, FileTerminal, FileText, FileVideo, Folder, FolderOpen, FolderPlus, House,
  Link2, LocateFixed, Pencil, RefreshCw, Search, Shield, Trash2, Unplug, Upload, X,
} from 'lucide-react';
import type { RemoteEntry, Server } from '../../shared/types';
import { Empty, IconButton, Spinner, cx, formatBytes, openMenu, plural, toast, type MenuItem } from '../ui/kit';
import { ChmodDialog, ConfirmDialog, NameDialog } from './dialogs';
import { EditorDialog } from './EditorDialog';
import { onTransferEvent } from './stores';
import {
  api, collator, errorText, fileKind, formatDate, isEditable, joinPath, loadPref, modeString,
  parentPath, savePref, validName, type FileKind,
} from './util';

export interface SftpPanelProps {
  sessionId: string;
  server: Server;
  connected: boolean;
  onClose?: () => void;
  /** Значение «следовать за папкой терминала» по умолчанию (из настроек приложения). */
  followDefault?: boolean;
}

type SortKey = 'name' | 'size' | 'mtime' | 'mode';

type PanelDialog =
  | { kind: 'mkdir'; dir: string }
  | { kind: 'newfile'; dir: string }
  | { kind: 'rename'; entry: RemoteEntry }
  | { kind: 'delete'; entries: RemoteEntry[] }
  | { kind: 'chmod'; entries: RemoteEntry[] };

const KIND_ICON: Record<FileKind, { icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>; color: string }> = {
  dir: { icon: Folder, color: '#F2C661' },
  link: { icon: Link2, color: '#4EA8FF' },
  image: { icon: FileImage, color: '#B48CFF' },
  video: { icon: FileVideo, color: '#FF7AA2' },
  audio: { icon: FileAudio, color: '#FF7AA2' },
  archive: { icon: FileArchive, color: '#FFB454' },
  code: { icon: FileCode2, color: '#4EA8FF' },
  config: { icon: FileCog, color: '#5CE1E6' },
  text: { icon: FileText, color: '#C7D0DA' },
  key: { icon: FileKey, color: '#3DDC97' },
  binary: { icon: FileTerminal, color: '#8B95A5' },
  pdf: { icon: FileText, color: '#FF5C6C' },
  doc: { icon: FileText, color: '#4EA8FF' },
  file: { icon: FileIcon, color: '#8B95A5' },
};

export function EntryIcon({ entry, size = 16 }: { entry: Pick<RemoteEntry, 'name' | 'isDir' | 'isLink'>; size?: number }) {
  const kind = fileKind(entry);
  const { icon: Icon, color } = KIND_ICON[kind];
  return <Icon size={size} color={color} strokeWidth={1.8} />;
}

/** Получить реальные пути перетаскиваемых файлов (preload может отдавать через webUtils). */
function pathsForDroppedFiles(files: File[]): string[] {
  const t = window.termuxx as unknown as { pathsForFiles?: (files: File[]) => string[] };
  if (typeof t.pathsForFiles === 'function') {
    try {
      return t.pathsForFiles(files).filter(Boolean);
    } catch {
      return [];
    }
  }
  // Старые Electron: File.path.
  return files.map((f) => (f as File & { path?: string }).path ?? '').filter(Boolean);
}

export function SftpPanel({ sessionId, server, connected, onClose, followDefault }: SftpPanelProps) {
  const [path, setPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(() => loadPref<SortKey>('sftp.sortKey', 'name'));
  const [sortDir, setSortDir] = useState<1 | -1>(() => loadPref<1 | -1>('sftp.sortDir', 1));
  const [showHidden, setShowHidden] = useState<boolean>(() => loadPref('sftp.showHidden', false));
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [follow, setFollow] = useState<boolean>(server.followTerminalFolder ?? followDefault ?? true);
  const [dialog, setDialog] = useState<PanelDialog | null>(null);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [width, setWidth] = useState(360);

  const seqRef = useRef(0);
  const pathRef = useRef<string | null>(null);
  const lastCwdRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  pathRef.current = path;

  useEffect(() => { savePref('sftp.sortKey', sortKey); }, [sortKey]);
  useEffect(() => { savePref('sftp.sortDir', sortDir); }, [sortDir]);
  useEffect(() => { savePref('sftp.showHidden', showHidden); }, [showHidden]);

  // Ширина панели → какие колонки показывать.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((items) => setWidth(items[0]?.contentRect.width ?? 360));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const showModified = width >= 400;
  const showPerms = width >= 540;

  /** Перейти в папку. Возвращает true при успехе. */
  const load = useCallback(async (target: string, opts?: { keepSelection?: boolean; quiet?: boolean }): Promise<boolean> => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const list = await api().sftpList(sessionId, target);
      if (seq !== seqRef.current) return false;
      setEntries(list);
      setPath(target);
      setPathInput(target);
      setInitError(null);
      if (!opts?.keepSelection) {
        setSelected(new Set());
        setAnchor(null);
      } else {
        const names = new Set(list.map((e) => e.path));
        setSelected((prev) => new Set([...prev].filter((p) => names.has(p))));
      }
      return true;
    } catch (err) {
      if (seq !== seqRef.current) return false;
      const msg = errorText(err);
      if (pathRef.current === null) setInitError(msg);
      else if (!opts?.quiet) toast(`Не удалось открыть ${target}: ${msg}`, 'error');
      setPathInput(pathRef.current ?? '');
      return false;
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [sessionId]);

  const reload = useCallback(() => {
    if (pathRef.current) void load(pathRef.current, { keepSelection: true });
  }, [load]);

  // Начальная загрузка: домашняя папка.
  useEffect(() => {
    seqRef.current++;
    setPath(null);
    setEntries([]);
    setSelected(new Set());
    setInitError(null);
    lastCwdRef.current = null;
    if (!connected) return;
    let alive = true;
    setLoading(true);
    api().sftpHome(sessionId)
      .then((home) => { if (alive) void load(home || '/'); })
      .catch((err) => { if (alive) { setInitError(errorText(err)); setLoading(false); } });
    return () => { alive = false; };
  }, [sessionId, connected, load]);

  // Следовать за папкой терминала.
  useEffect(() => {
    if (!follow || !connected || path === null) return;
    let alive = true;
    const tick = async () => {
      try {
        const cwd = await api().remoteCwd(sessionId);
        if (!alive || !cwd || cwd === lastCwdRef.current) return;
        lastCwdRef.current = cwd;
        if (cwd !== pathRef.current) void load(cwd, { quiet: true });
      } catch {
        /* терминал может быть занят — попробуем позже */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, [follow, connected, sessionId, path === null, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Обновить список, когда закончилась загрузка файлов в эту сессию.
  useEffect(() => {
    let timer = 0;
    const off = onTransferEvent((p) => {
      if (p.sessionId !== sessionId || p.direction !== 'upload') return;
      if (p.state === 'done' || p.state === 'error' || p.state === 'cancelled') {
        window.clearTimeout(timer);
        timer = window.setTimeout(reload, 300);
      }
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [sessionId, reload]);

  // ---------- видимый список ----------

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = entries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r = 0;
      switch (sortKey) {
        case 'size': r = a.size - b.size; break;
        case 'mtime': r = a.mtime - b.mtime; break;
        case 'mode': r = (a.mode & 0o7777) - (b.mode & 0o7777); break;
        default: r = 0;
      }
      if (r === 0) r = collator.compare(a.name, b.name);
      return r * sortDir;
    });
    return list;
  }, [entries, showHidden, filter, sortKey, sortDir]);

  const hiddenCount = useMemo(() => entries.filter((e) => e.name.startsWith('.')).length, [entries]);
  const selection = useMemo(() => visible.filter((e) => selected.has(e.path)), [visible, selected]);

  const setSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };

  // ---------- действия ----------

  const openExternal = useCallback(async (entry: RemoteEntry) => {
    try {
      await api().sftpOpenExternal(sessionId, entry.path);
      toast(`«${entry.name}» открыт во внешней программе — сохранённые изменения загрузятся на сервер автоматически`);
    } catch (err) {
      toast(`Не удалось открыть: ${errorText(err)}`, 'error');
    }
  }, [sessionId]);

  const openEntry = useCallback(async (entry: RemoteEntry) => {
    if (entry.isDir) { void load(entry.path); return; }
    if (entry.isLink) {
      // Ссылка может вести на папку — пробуем как папку.
      if (await load(entry.path, { quiet: true })) return;
    }
    if (isEditable(entry)) setEditorPath(entry.path);
    else void openExternal(entry);
  }, [load, openExternal]);

  const download = useCallback(async (items: RemoteEntry[]) => {
    if (items.length === 0) return;
    try {
      await api().sftpDownload(sessionId, items.map((e) => e.path));
    } catch (err) {
      toast(`Скачивание не началось: ${errorText(err)}`, 'error');
    }
  }, [sessionId]);

  const uploadTo = useCallback(async (dir: string, localPaths?: string[]) => {
    try {
      await api().sftpUpload(sessionId, dir, localPaths);
    } catch (err) {
      toast(`Загрузка не началась: ${errorText(err)}`, 'error');
    }
  }, [sessionId]);

  const copyPaths = (paths: string[]) => {
    api().clipboardWrite(paths.join('\n'));
    toast(paths.length === 1 ? 'Путь скопирован' : `Скопировано путей: ${paths.length}`);
  };

  const goUp = () => { if (path && path !== '/') void load(parentPath(path)); };
  const goHome = async () => {
    try { void load(await api().sftpHome(sessionId)); } catch (err) { toast(errorText(err), 'error'); }
  };

  // ---------- выделение ----------

  const clickRow = (e: React.MouseEvent, entry: RemoteEntry) => {
    if (e.shiftKey && anchor) {
      const a = visible.findIndex((x) => x.path === anchor);
      const b = visible.findIndex((x) => x.path === entry.path);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        const range = visible.slice(from, to + 1).map((x) => x.path);
        setSelected(e.ctrlKey || e.metaKey ? new Set([...selected, ...range]) : new Set(range));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
      setSelected(next);
      setAnchor(entry.path);
      return;
    }
    setSelected(new Set([entry.path]));
    setAnchor(entry.path);
  };

  const moveSelection = (delta: number, extend: boolean) => {
    if (visible.length === 0) return;
    const current = anchor ? visible.findIndex((x) => x.path === anchor) : -1;
    const next = Math.max(0, Math.min(visible.length - 1, current < 0 ? (delta > 0 ? 0 : visible.length - 1) : current + delta));
    const target = visible[next];
    if (extend) setSelected(new Set([...selected, target.path]));
    else setSelected(new Set([target.path]));
    setAnchor(target.path);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (dialog || editorPath) return;
    const single = selection.length === 1 ? selection[0] : null;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveSelection(1, e.shiftKey); break;
      case 'ArrowUp': e.preventDefault(); moveSelection(-1, e.shiftKey); break;
      case 'Home': e.preventDefault(); moveSelection(-visible.length, false); break;
      case 'End': e.preventDefault(); moveSelection(visible.length, false); break;
      case 'Enter': if (single) { e.preventDefault(); void openEntry(single); } break;
      case 'Backspace': e.preventDefault(); goUp(); break;
      case 'Delete': if (selection.length) { e.preventDefault(); setDialog({ kind: 'delete', entries: selection }); } break;
      case 'F2': if (single) { e.preventDefault(); setDialog({ kind: 'rename', entry: single }); } break;
      case 'F5': e.preventDefault(); reload(); break;
      default:
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          setSelected(new Set(visible.map((x) => x.path)));
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selection.length) {
          e.preventDefault();
          copyPaths(selection.map((x) => x.path));
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          setFilterOpen(true);
          setTimeout(() => filterRef.current?.focus(), 0);
        }
    }
  };

  // ---------- меню ----------

  const rowMenu = (e: React.MouseEvent, entry: RemoteEntry) => {
    let items = selection;
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      setAnchor(entry.path);
      items = [entry];
    }
    const single = items.length === 1 ? items[0] : null;
    const menu: MenuItem[] = [];
    if (single) {
      menu.push({ label: single.isDir ? 'Открыть папку' : 'Открыть', icon: single.isDir ? <FolderOpen size={15} /> : <FileText size={15} />, shortcut: 'Enter', onClick: () => void openEntry(single) });
      if (!single.isDir) {
        menu.push({ label: 'Открыть во внешнем редакторе', icon: <ExternalLink size={15} />, onClick: () => void openExternal(single) });
      }
    }
    menu.push({ label: items.length > 1 ? `Скачать (${items.length})…` : 'Скачать…', icon: <Download size={15} />, onClick: () => void download(items) });
    menu.push({ separator: true });
    const uploadDir = single?.isDir ? single.path : path ?? '/';
    menu.push({ label: single?.isDir ? `Загрузить в «${single.name}»…` : 'Загрузить сюда…', icon: <Upload size={15} />, onClick: () => void uploadTo(uploadDir) });
    menu.push({ label: 'Новая папка…', icon: <FolderPlus size={15} />, onClick: () => setDialog({ kind: 'mkdir', dir: path ?? '/' }) });
    menu.push({ label: 'Новый файл…', icon: <FilePlus size={15} />, onClick: () => setDialog({ kind: 'newfile', dir: path ?? '/' }) });
    menu.push({ separator: true });
    if (single) menu.push({ label: 'Переименовать', icon: <Pencil size={15} />, shortcut: 'F2', onClick: () => setDialog({ kind: 'rename', entry: single }) });
    menu.push({ label: 'Права доступа…', icon: <Shield size={15} />, onClick: () => setDialog({ kind: 'chmod', entries: items }) });
    menu.push({ label: items.length > 1 ? 'Копировать пути' : 'Копировать путь', icon: <Copy size={15} />, shortcut: 'Ctrl+C', onClick: () => copyPaths(items.map((x) => x.path)) });
    menu.push({ separator: true });
    menu.push({
      label: items.length > 1 ? `Удалить (${items.length})` : 'Удалить',
      icon: <Trash2 size={15} />,
      shortcut: 'Del',
      danger: true,
      onClick: () => setDialog({ kind: 'delete', entries: items }),
    });
    openMenu(e, menu);
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.tx-row')) return;
    setSelected(new Set());
    const dir = path ?? '/';
    openMenu(e, [
      { label: 'Загрузить сюда…', icon: <Upload size={15} />, onClick: () => void uploadTo(dir) },
      { label: 'Новая папка…', icon: <FolderPlus size={15} />, onClick: () => setDialog({ kind: 'mkdir', dir }) },
      { label: 'Новый файл…', icon: <FilePlus size={15} />, onClick: () => setDialog({ kind: 'newfile', dir }) },
      { separator: true },
      { label: 'Обновить', icon: <RefreshCw size={15} />, shortcut: 'F5', onClick: reload },
      { label: showHidden ? 'Скрыть скрытые файлы' : 'Показать скрытые файлы', icon: showHidden ? <EyeOff size={15} /> : <Eye size={15} />, onClick: () => setShowHidden(!showHidden) },
      { label: 'Копировать путь папки', icon: <Copy size={15} />, onClick: () => copyPaths([dir]) },
    ]);
  };

  // ---------- перетаскивание из Проводника ----------

  const onDragOver = (e: React.DragEvent) => {
    if (!connected || path === null) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !rootRef.current?.contains(next)) setDragOver(false);
  };

  const onDrop = (e: React.DragEvent) => {
    if (!connected || path === null) return;
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const dirRow = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]');
    const dir = dirRow?.dataset.dir || path;
    const localPaths = pathsForDroppedFiles(files);
    if (localPaths.length > 0) {
      void uploadTo(dir, localPaths);
    } else {
      toast('Не удалось получить пути файлов — выберите их в окне');
      void uploadTo(dir);
    }
  };

  // ---------- диалоги ----------

  const dialogNode = (() => {
    if (!dialog) return null;
    const close = () => setDialog(null);
    switch (dialog.kind) {
      case 'mkdir':
        return (
          <NameDialog
            title="Новая папка"
            label={`В папке ${dialog.dir}`}
            initial="новая папка"
            confirmText="Создать"
            validate={(v) => validName(v) ?? (entries.some((x) => x.name === v.trim()) ? 'Такое имя уже есть' : null)}
            onClose={close}
            onSubmit={async (name) => {
              try {
                await api().sftpMkdir(sessionId, joinPath(dialog.dir, name));
                close();
                await load(dialog.dir);
                const created = joinPath(dialog.dir, name);
                setSelected(new Set([created]));
                setAnchor(created);
              } catch (err) {
                toast(`Не удалось создать папку: ${errorText(err)}`, 'error');
              }
            }}
          />
        );
      case 'newfile':
        return (
          <NameDialog
            title="Новый файл"
            label={`В папке ${dialog.dir}`}
            initial="новый файл.txt"
            confirmText="Создать и открыть"
            selectBaseName
            validate={(v) => validName(v) ?? (entries.some((x) => x.name === v.trim()) ? 'Такое имя уже есть' : null)}
            onClose={close}
            onSubmit={async (name) => {
              const target = joinPath(dialog.dir, name);
              try {
                await api().sftpWriteText(sessionId, target, '');
                close();
                await load(dialog.dir);
                setEditorPath(target);
              } catch (err) {
                toast(`Не удалось создать файл: ${errorText(err)}`, 'error');
              }
            }}
          />
        );
      case 'rename':
        return (
          <NameDialog
            title="Переименовать"
            label={dialog.entry.path}
            initial={dialog.entry.name}
            confirmText="Переименовать"
            selectBaseName={!dialog.entry.isDir}
            validate={(v) => validName(v) ?? (v.trim() !== dialog.entry.name && entries.some((x) => x.name === v.trim()) ? 'Такое имя уже есть' : null)}
            onClose={close}
            onSubmit={async (name) => {
              if (name === dialog.entry.name) { close(); return; }
              const target = joinPath(parentPath(dialog.entry.path), name);
              try {
                await api().sftpRename(sessionId, dialog.entry.path, target);
                close();
                await load(path ?? parentPath(dialog.entry.path));
                setSelected(new Set([target]));
                setAnchor(target);
              } catch (err) {
                toast(`Не удалось переименовать: ${errorText(err)}`, 'error');
              }
            }}
          />
        );
      case 'delete': {
        const items = dialog.entries;
        const dirs = items.filter((x) => x.isDir).length;
        const what = items.length === 1
          ? `«${items[0].name}»`
          : `${items.length} ${plural(items.length, 'объект', 'объекта', 'объектов')}`;
        return (
          <ConfirmDialog
            title="Удалить?"
            message={<>Удалить {what} с сервера? Это действие нельзя отменить.</>}
            confirmText="Удалить"
            danger
            onClose={close}
            onConfirm={async () => {
              try {
                await api().sftpDelete(sessionId, items.map((x) => x.path));
                close();
                toast(items.length === 1 ? `Удалено: ${items[0].name}` : `Удалено объектов: ${items.length}`, 'success');
                reload();
              } catch (err) {
                toast(`Не удалось удалить: ${errorText(err)}`, 'error');
                reload();
              }
            }}
          >
            {dirs > 0 && <div className="tx-warn-box">Папки будут удалены вместе со всем содержимым.</div>}
          </ConfirmDialog>
        );
      }
      case 'chmod': {
        const items = dialog.entries;
        return (
          <ChmodDialog
            names={items.map((x) => x.name)}
            mode={items[0].mode}
            isDir={items[0].isDir}
            onClose={close}
            onApply={async (mode) => {
              try {
                for (const it of items) await api().sftpChmod(sessionId, it.path, mode);
                close();
                toast('Права изменены', 'success');
                reload();
              } catch (err) {
                toast(`Не удалось изменить права: ${errorText(err)}`, 'error');
              }
            }}
          />
        );
      }
    }
  })();

  // ---------- отрисовка ----------

  const header = (
    <div className="tx-sftp-header">
      <div className="tx-sftp-title">
        <span className={cx('dot', connected ? 'ok' : 'off')} />
        <span className="ellipsis">SFTP · {server.name || server.hostname}</span>
        {loading && path !== null && <Spinner size={12} />}
      </div>
      <div className="tx-sftp-tools">
        <IconButton title="Вверх (Backspace)" onClick={goUp} disabled={!connected || !path || path === '/'}><ArrowUp size={15} /></IconButton>
        <IconButton title="Домашняя папка" onClick={() => void goHome()} disabled={!connected}><House size={15} /></IconButton>
        <IconButton title="Обновить (F5)" onClick={reload} disabled={!connected || !path}><RefreshCw size={15} /></IconButton>
        <IconButton
          title={follow ? 'Следовать за папкой терминала: вкл' : 'Следовать за папкой терминала: выкл'}
          active={follow}
          onClick={() => setFollow(!follow)}
          disabled={!connected}
        >
          <LocateFixed size={15} />
        </IconButton>
        <span className="tx-sep" />
        <IconButton title="Загрузить файлы сюда" onClick={() => void uploadTo(path ?? '/')} disabled={!connected || !path}><Upload size={15} /></IconButton>
        <IconButton title="Новая папка" onClick={() => setDialog({ kind: 'mkdir', dir: path ?? '/' })} disabled={!connected || !path}><FolderPlus size={15} /></IconButton>
        <IconButton title={showHidden ? 'Скрыть скрытые файлы' : `Показать скрытые файлы${hiddenCount ? ` (${hiddenCount})` : ''}`} active={showHidden} onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </IconButton>
        <IconButton title="Фильтр (Ctrl+F)" active={filterOpen} onClick={() => { setFilterOpen(!filterOpen); if (filterOpen) setFilter(''); else setTimeout(() => filterRef.current?.focus(), 0); }}>
          <Search size={15} />
        </IconButton>
        {onClose && <IconButton title="Скрыть панель" onClick={onClose}><X size={15} /></IconButton>}
      </div>
      <input
        className="input mono tx-path-input"
        value={pathInput}
        disabled={!connected || path === null}
        spellCheck={false}
        onChange={(e) => setPathInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void load(pathInput.trim() || '/');
          if (e.key === 'Escape') { setPathInput(path ?? ''); (e.target as HTMLInputElement).blur(); }
        }}
        onBlur={() => setPathInput(path ?? '')}
        title="Путь на сервере — можно ввести и нажать Enter"
      />
      {filterOpen && (
        <input
          ref={filterRef}
          className="input tx-filter-input"
          placeholder="Фильтр по имени…"
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setFilter(''); setFilterOpen(false); listRef.current?.focus(); } }}
        />
      )}
    </div>
  );

  let body: React.ReactNode;
  if (!connected) {
    body = (
      <Empty icon={<Unplug size={34} className="faint" />} title="Нет подключения">
        <span>Файлы сервера появятся здесь, когда SSH-сессия подключится.</span>
      </Empty>
    );
  } else if (path === null) {
    body = initError
      ? (
        <Empty icon={<Unplug size={34} className="tx-error-text" />} title="SFTP недоступен">
          <span className="tx-error-text">{initError}</span>
          <button className="btn small" onClick={() => { setInitError(null); void goHome(); }}>Повторить</button>
        </Empty>
      )
      : <div className="tx-center"><Spinner size={20} /><span className="muted">Открываю SFTP…</span></div>;
  } else {
    body = (
      <>
        <div className="tx-cols tx-cols-head">
          <button className="tx-col-name" onClick={() => setSort('name')}>Имя{sortKey === 'name' && <SortMark dir={sortDir} />}</button>
          <button className="tx-col-size" onClick={() => setSort('size')}>Размер{sortKey === 'size' && <SortMark dir={sortDir} />}</button>
          {showModified && <button className="tx-col-date" onClick={() => setSort('mtime')}>Изменён{sortKey === 'mtime' && <SortMark dir={sortDir} />}</button>}
          {showPerms && <button className="tx-col-perm" onClick={() => setSort('mode')}>Права{sortKey === 'mode' && <SortMark dir={sortDir} />}</button>}
        </div>
        <div
          ref={listRef}
          className="tx-list"
          tabIndex={0}
          onKeyDown={onListKeyDown}
          onContextMenu={backgroundMenu}
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setSelected(new Set()); } }}
        >
          {path !== '/' && (
            <div className="tx-row tx-cols tx-row-up" onDoubleClick={goUp} title="На уровень выше">
              <span className="tx-col-name"><ArrowUp size={15} className="faint" /><span>..</span></span>
            </div>
          )}
          {visible.map((entry, index) => (
            <div
              key={entry.path}
              data-index={index}
              data-dir={entry.isDir ? entry.path : undefined}
              className={cx('tx-row tx-cols', selected.has(entry.path) && 'selected', entry.name.startsWith('.') && 'hidden-file')}
              onMouseDown={(e) => { if (e.button === 0) clickRow(e, entry); }}
              onDoubleClick={() => void openEntry(entry)}
              onContextMenu={(e) => rowMenu(e, entry)}
              title={entry.isLink ? `${entry.path} (ссылка)` : entry.path}
            >
              <span className="tx-col-name">
                <EntryIcon entry={entry} />
                <span className={cx('ellipsis', entry.isLink && 'tx-link-name')}>{entry.name}</span>
              </span>
              <span className="tx-col-size">{entry.isDir ? '' : formatBytes(entry.size)}</span>
              {showModified && <span className="tx-col-date" title={formatDate(entry.mtime)}>{formatDate(entry.mtime, true)}</span>}
              {showPerms && <span className="tx-col-perm mono">{modeString(entry.mode, entry.isDir, entry.isLink)}</span>}
            </div>
          ))}
          {visible.length === 0 && (
            <div className="tx-list-empty">
              {filter.trim()
                ? <>Ничего не найдено по «{filter.trim()}»</>
                : <>Папка пуста.<br /><span className="faint">Перетащите сюда файлы из Проводника, чтобы загрузить их.</span></>}
            </div>
          )}
        </div>
      </>
    );
  }

  const totalSize = selection.reduce((n, x) => n + (x.isDir ? 0 : x.size), 0);

  return (
    <div
      ref={rootRef}
      className={cx('tx-sftp', dragOver && 'drag-over')}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {header}
      <div className="tx-sftp-body">{body}</div>
      {connected && path !== null && (
        <div className="tx-sftp-status">
          <span>
            {visible.length} {plural(visible.length, 'объект', 'объекта', 'объектов')}
            {!showHidden && hiddenCount > 0 && <span className="faint"> · скрытых: {hiddenCount}</span>}
          </span>
          {selection.length > 0 && (
            <span className="tx-accent">
              выбрано {selection.length}{totalSize > 0 ? ` · ${formatBytes(totalSize)}` : ''}
            </span>
          )}
        </div>
      )}
      {dragOver && (
        <div className="tx-drop-overlay">
          <Upload size={28} />
          <span>Отпустите, чтобы загрузить в<br /><span className="mono">{path}</span></span>
        </div>
      )}
      {dialogNode}
      {editorPath && (
        <EditorDialog
          sessionId={sessionId}
          path={editorPath}
          onClose={() => { setEditorPath(null); listRef.current?.focus(); }}
          onSaved={reload}
        />
      )}
    </div>
  );
}

function SortMark({ dir }: { dir: 1 | -1 }) {
  return <span className="tx-sort">{dir === 1 ? '▲' : '▼'}</span>;
}
