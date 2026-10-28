// Встроенный редактор удалённых файлов на CodeMirror 6 (Ctrl+S — сохранить на сервер).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { StreamLanguage, LanguageSupport } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { go } from '@codemirror/legacy-modes/mode/go';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { xml, html } from '@codemirror/legacy-modes/mode/xml';
import { css } from '@codemirror/legacy-modes/mode/css';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { c, cpp, java, csharp, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { ExternalLink, FileCode2, Save, X } from 'lucide-react';
import { Button, IconButton, Spinner, formatBytes, toast } from '../ui/kit';
import { api, baseName, errorText, extOf } from './util';

interface Lang { name: string; ext: () => Extension }

const legacy = (name: string, parser: Parameters<typeof StreamLanguage.define>[0]): Lang =>
  ({ name, ext: () => new LanguageSupport(StreamLanguage.define(parser)) });

/** Подбор подсветки по имени файла и пути. */
export function languageFor(path: string): Lang | null {
  const name = baseName(path).toLowerCase();
  const ext = extOf(name);
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || ext === 'dockerfile') return legacy('Dockerfile', dockerFile);
  if (name === 'nginx.conf' || path.includes('/nginx/') || ext === 'nginx') return legacy('Nginx', nginx);
  if (['.bashrc', '.bash_profile', '.profile', '.zshrc', '.bash_aliases', '.bash_logout'].includes(name)) return legacy('Shell', shell);
  switch (ext) {
    case 'json': case 'json5': case 'jsonc': case 'lock': return { name: 'JSON', ext: () => json() };
    case 'yml': case 'yaml': return { name: 'YAML', ext: () => yaml() };
    case 'py': case 'pyw': return { name: 'Python', ext: () => python() };
    case 'js': case 'mjs': case 'cjs': return { name: 'JavaScript', ext: () => javascript() };
    case 'jsx': return { name: 'JSX', ext: () => javascript({ jsx: true }) };
    case 'ts': case 'mts': case 'cts': return { name: 'TypeScript', ext: () => javascript({ typescript: true }) };
    case 'tsx': return { name: 'TSX', ext: () => javascript({ typescript: true, jsx: true }) };
    case 'sh': case 'bash': case 'zsh': case 'ksh': return legacy('Shell', shell);
    case 'conf': case 'cfg': case 'ini': case 'properties': case 'env': case 'service': case 'timer': case 'socket':
      return legacy('INI', properties);
    case 'toml': return legacy('TOML', toml);
    case 'lua': return legacy('Lua', lua);
    case 'go': return legacy('Go', go);
    case 'rs': return legacy('Rust', rust);
    case 'xml': case 'plist': case 'svg': return legacy('XML', xml);
    case 'html': case 'htm': return legacy('HTML', html);
    case 'css': case 'scss': case 'less': return legacy('CSS', css);
    case 'sql': return legacy('SQL', standardSQL);
    case 'c': case 'h': return legacy('C', c);
    case 'cc': case 'cpp': case 'hpp': case 'cxx': return legacy('C++', cpp);
    case 'java': return legacy('Java', java);
    case 'cs': return legacy('C#', csharp);
    case 'kt': case 'kts': return legacy('Kotlin', kotlin);
    case 'rb': return legacy('Ruby', ruby);
    case 'pl': case 'pm': return legacy('Perl', perl);
    case 'ps1': case 'psm1': return legacy('PowerShell', powerShell);
    case 'diff': case 'patch': return legacy('Diff', diff);
    case 'swift': return legacy('Swift', swift);
    default: return null;
  }
}

/** Цвета редактора под палитру Termuxx поверх one-dark. */
const termuxxTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#0B0F16', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: '#3DDC97' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#3DDC97', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: '#0B0F16', color: '#4B5563', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(61, 220, 151, 0.08)', color: '#A3ADBB' },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'rgba(61, 220, 151, 0.22) !important' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 180, 84, 0.25)', outline: '1px solid rgba(255, 180, 84, 0.5)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(61, 220, 151, 0.35)' },
  '.cm-panels': { backgroundColor: '#141A24', color: '#E8EDF3', borderColor: 'rgba(255,255,255,0.08)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'var(--font-ui)' },
  '.cm-panel.cm-search input[type=text]': { background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', color: '#E8EDF3', padding: '3px 6px' },
  '.cm-button': { backgroundImage: 'none', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', color: '#E8EDF3' },
  '.cm-tooltip': { backgroundColor: '#1A202B', border: '1px solid rgba(255,255,255,0.12)' },
}, { dark: true });

export interface EditorDialogProps {
  sessionId: string;
  path: string;
  /** Если не задан — текст загружается с сервера. */
  initialText?: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function EditorDialog({ sessionId, path, initialText, onClose, onSaved }: EditorDialogProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedDocRef = useRef<string>('');
  const [loading, setLoading] = useState(initialText === undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [size, setSize] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);
  const lang = languageFor(path);

  const save = useCallback(async (): Promise<boolean> => {
    const view = viewRef.current;
    if (!view) return false;
    const text = view.state.doc.toString();
    setSaving(true);
    try {
      await api().sftpWriteText(sessionId, path, text);
      savedDocRef.current = text;
      setDirty(false);
      toast(`Сохранено: ${baseName(path)}`, 'success');
      onSaved?.();
      return true;
    } catch (err) {
      toast(`Не удалось сохранить: ${errorText(err)}`, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [sessionId, path, onSaved]);

  const saveRef = useRef(save);
  saveRef.current = save;

  // Загрузка текста.
  const [text, setText] = useState<string | null>(initialText ?? null);
  useEffect(() => {
    if (initialText !== undefined) return;
    let alive = true;
    api().sftpReadText(sessionId, path)
      .then((t) => { if (alive) { setText(t); setLoading(false); } })
      .catch((err) => { if (alive) { setLoadError(errorText(err)); setLoading(false); } });
    return () => { alive = false; };
  }, [sessionId, path, initialText]);

  // Создание редактора, когда текст готов.
  useEffect(() => {
    if (text === null || !hostRef.current) return;
    savedDocRef.current = text;
    setSize(new Blob([text]).size);
    const languageConf = new Compartment();
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          oneDark,
          Prec.highest(termuxxTheme),
          languageConf.of(lang ? lang.ext() : []),
          EditorState.tabSize.of(4),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void saveRef.current(); return true; } }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const doc = u.state.doc.toString();
              setDirty(doc !== savedDocRef.current);
              setSize(new Blob([doc]).size);
            }
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              setCursor({ line: line.number, col: head - line.from + 1 });
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => { view.destroy(); viewRef.current = null; };
    // Язык и сохранение берутся из рефов; пересоздаём только при смене текста.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else onClose();
  }, [dirty, onClose]);

  // Ctrl+W закрывает редактор; Escape — только когда нет открытой панели поиска.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        e.stopPropagation();
        requestClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [requestClose]);

  const openExternal = async () => {
    try {
      await api().sftpOpenExternal(sessionId, path);
      toast('Открыто во внешнем редакторе — изменения загрузятся автоматически');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div className="dialog full tx-editor" role="dialog">
        <div className="dialog-header">
          <FileCode2 size={18} className="tx-accent" />
          <h2 className="ellipsis" title={path}>
            {baseName(path)}
            {dirty && <span className="tx-dirty" title="Есть несохранённые изменения">●</span>}
            <span className="tx-editor-path mono">{path}</span>
          </h2>
          <Button small icon={<ExternalLink size={14} />} onClick={openExternal}>Во внешнем редакторе</Button>
          <Button small variant="primary" icon={saving ? <Spinner size={12} /> : <Save size={14} />} disabled={!dirty || saving} onClick={() => void save()}>
            Сохранить
          </Button>
          <IconButton title="Закрыть (Ctrl+W)" onClick={requestClose}><X size={16} /></IconButton>
        </div>
        <div className="tx-editor-body">
          {loading && <div className="tx-center"><Spinner size={22} /><span className="muted">Загрузка файла…</span></div>}
          {loadError && <div className="tx-center"><span className="tx-error-text">Не удалось открыть файл: {loadError}</span></div>}
          <div ref={hostRef} className="tx-editor-host" style={{ display: loading || loadError ? 'none' : undefined }} />
        </div>
        <div className="tx-editor-status">
          <span>{lang?.name ?? 'Текст'}</span>
          <span>UTF-8</span>
          <span>Стр. {cursor.line}, стлб {cursor.col}</span>
          <span>{formatBytes(size)}</span>
          <span className="grow" />
          <span className="faint">Ctrl+S — сохранить · Ctrl+F — поиск · Ctrl+W — закрыть</span>
        </div>
        {confirmClose && (
          <div className="tx-confirm-overlay">
            <div className="tx-confirm glass">
              <div className="tx-confirm-title">Сохранить изменения в «{baseName(path)}»?</div>
              <div className="muted">Если не сохранить, правки пропадут.</div>
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
                <Button onClick={() => setConfirmClose(false)}>Отмена</Button>
                <Button variant="danger" onClick={onClose}>Не сохранять</Button>
                <Button variant="primary" onClick={async () => { if (await save()) onClose(); }}>Сохранить</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
