import React, { useEffect, useState } from 'react';
import {
  Archive, Check, Copy, Download, FolderOpen, Info, KeyRound, ListPlus, Lock, Palette, Pencil, Plus, Send,
  SquareTerminal, Trash, Upload, Wand2,
} from 'lucide-react';
import type { BackupPreview, Settings, Snippet, SSHKeyItem } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';
import type { SettingsSection } from '../state';
import { errorText, newUUID, useApp } from '../state';
import { FONT_FAMILIES, THEMES, themeById } from '../themes';
import {
  Button, Dialog, Empty, Field, NumberInput, Segmented, Select, Spinner, TextArea, TextInput, Toggle, cx, plural, toast,
} from '../ui/kit';
import { activePaneId, sendToPane } from './sessions';
import { importPutty, importSshConfig } from './actions';

const api = () => window.termuxx;

export function useSaveSettings() {
  return (patch: Partial<Settings>) => {
    const st = useApp.getState();
    const next = { ...(st.data?.settings ?? DEFAULT_SETTINGS), ...patch };
    if (st.data) st.setData({ ...st.data, settings: next });
    void api().saveSettings(next).catch((err) => toast(errorText(err), 'error'));
  };
}

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  { id: 'appearance', label: 'Внешний вид', icon: <Palette size={15} /> },
  { id: 'terminal', label: 'Терминал', icon: <SquareTerminal size={15} /> },
  { id: 'keys', label: 'SSH-ключи', icon: <KeyRound size={15} /> },
  { id: 'snippets', label: 'Сниппеты', icon: <ListPlus size={15} /> },
  { id: 'backup', label: 'Резервная копия', icon: <Archive size={15} /> },
  { id: 'about', label: 'О программе', icon: <Info size={15} /> },
];

export function SettingsDialog({ section: initial, onClose }: { section?: SettingsSection; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>(initial ?? 'appearance');
  return (
    <Dialog title="Настройки" size="wide" onClose={onClose}>
      <div className="tx-settings">
        <nav className="tx-settings-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={cx('tx-settings-link', section === s.id && 'on')} onClick={() => setSection(s.id)}>
              {s.icon}<span>{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="tx-settings-body">
          {section === 'appearance' && <Appearance />}
          {section === 'terminal' && <TerminalSettings />}
          {section === 'keys' && <Keys />}
          {section === 'snippets' && <Snippets />}
          {section === 'backup' && <Backup />}
          {section === 'about' && <About />}
        </div>
      </div>
    </Dialog>
  );
}

function ThemeCard({ id, selected, onClick }: { id: string; selected: boolean; onClick: () => void }) {
  const t = themeById(id);
  return (
    <button className={cx('tx-theme', selected && 'on')} onClick={onClick} style={{ background: t.background, color: t.foreground }}>
      <div className="tx-theme-preview mono">
        <div><span style={{ color: t.ansi[2] }}>root@vps</span>:<span style={{ color: t.ansi[4] }}>~</span>$ ls</div>
        <div><span style={{ color: t.ansi[4] }}>docker</span> <span style={{ color: t.ansi[2] }}>run.sh</span> <span style={{ color: t.ansi[1] }}>err.log</span></div>
        <div style={{ display: 'flex', gap: 3, marginTop: 6 }}>
          {t.ansi.slice(0, 8).map((c, i) => <span key={i} style={{ width: 12, height: 6, borderRadius: 2, background: c }} />)}
        </div>
      </div>
      <div className="tx-theme-name">
        {selected && <Check size={12} />} {t.name}
      </div>
    </button>
  );
}

function Appearance() {
  const s = useApp((st) => st.data?.settings) ?? DEFAULT_SETTINGS;
  const save = useSaveSettings();
  const isWin = api().platform === 'win32';
  return (
    <div className="tx-form">
      <h3>Тема терминала</h3>
      <div className="tx-theme-grid">
        {THEMES.map((t) => <ThemeCard key={t.id} id={t.id} selected={s.themeID === t.id} onClick={() => save({ themeID: t.id })} />)}
      </div>
      <h3>Шрифт</h3>
      <div className="tx-form-grid">
        <Field label="Семейство">
          <Select value={s.fontFamily} onChange={(v) => save({ fontFamily: v })}
            options={FONT_FAMILIES.some((f) => f.value === s.fontFamily) ? FONT_FAMILIES : [...FONT_FAMILIES, { value: s.fontFamily, label: s.fontFamily }]} />
        </Field>
        <Field label={`Размер: ${s.fontSize}px`} hint="Ctrl+= / Ctrl+− / Ctrl+0">
          <input type="range" min={9} max={28} step={1} value={s.fontSize} onChange={(e) => save({ fontSize: Number(e.target.value) })} className="tx-range" />
        </Field>
      </div>
      <div className="tx-form-grid">
        <Field label={`Межстрочный интервал: ${s.lineHeight.toFixed(2)}`}>
          <input type="range" min={1} max={1.6} step={0.05} value={s.lineHeight} onChange={(e) => save({ lineHeight: Number(e.target.value) })} className="tx-range" />
        </Field>
        <Field label="Курсор">
          <div className="row">
            <Segmented value={s.cursorStyle} onChange={(v) => save({ cursorStyle: v })} options={[
              { value: 'block', label: '█ Блок' }, { value: 'bar', label: '│ Черта' }, { value: 'underline', label: '_ Подчёркивание' },
            ]} />
          </div>
        </Field>
      </div>
      <Toggle checked={s.cursorBlink} onChange={(v) => save({ cursorBlink: v })} label="Мигающий курсор" />
      <h3>Окно</h3>
      <Field label="Фон окна" hint={isWin ? 'Mica и Acrylic — эффекты Windows 11; применятся после перезапуска, если не сработали сразу' : 'Эффекты Mica и Acrylic доступны только в Windows 11'}>
        <Segmented value={s.backgroundMaterial} onChange={(v) => save({ backgroundMaterial: v })} options={[
          { value: 'mica', label: 'Mica' }, { value: 'acrylic', label: 'Acrylic' }, { value: 'none', label: 'Без эффекта' },
        ]} />
      </Field>
    </div>
  );
}

function TerminalSettings() {
  const s = useApp((st) => st.data?.settings) ?? DEFAULT_SETTINGS;
  const shells = useApp((st) => st.shells);
  const save = useSaveSettings();
  return (
    <div className="tx-form">
      <h3>Поведение</h3>
      <Toggle checked={s.copyOnSelect} onChange={(v) => save({ copyOnSelect: v })} label="Копировать при выделении" hint="Как в PuTTY и MobaXterm" />
      <Toggle checked={s.rightClickPaste} onChange={(v) => save({ rightClickPaste: v })} label="Вставка правой кнопкой мыши" hint="Shift + правая кнопка — контекстное меню" />
      <Toggle checked={s.confirmCloseTab} onChange={(v) => save({ confirmCloseTab: v })} label="Спрашивать перед закрытием активной сессии" />
      <Toggle checked={s.bellSound} onChange={(v) => save({ bellSound: v })} label="Звуковой сигнал (bell)" />
      <Field label="История прокрутки (строк)">
        <NumberInput value={s.scrollback} min={500} max={200000} onChange={(v) => save({ scrollback: Math.max(500, Math.min(200000, Math.round(v))) })} />
      </Field>
      <Field label="Оболочка по умолчанию (Ctrl+Shift+T)">
        <Select value={s.defaultShellID ?? ''} onChange={(v) => save({ defaultShellID: v || null })}
          options={[{ value: '', label: shells[0] ? `Автоматически (${shells[0].name})` : 'Автоматически' }, ...shells.map((sh) => ({ value: sh.id, label: sh.name }))]} />
      </Field>
      <h3>SSH</h3>
      <Toggle checked={s.sftpFollowsTerminal} onChange={(v) => save({ sftpFollowsTerminal: v })} label="SFTP-панель следует за папкой терминала" hint="Панель переходит в текущую папку оболочки" />
      <Toggle checked={s.showRemoteMonitorBar} onChange={(v) => save({ showRemoteMonitorBar: v })} label="Строка мониторинга сервера" hint="CPU, память и диск внизу окна, как в MobaXterm" />
    </div>
  );
}

function KeyRow({ k }: { k: SSHKeyItem }) {
  const hosts = useApp((s) => s.data?.hosts) ?? [];
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const setDialog = useApp((s) => s.setDialog);
  const install = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const out = await api().installKey(k.id, target);
      toast(out.trim() ? `Готово: ${out.trim().slice(0, 200)}` : 'Ключ установлен на сервер', 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tx-key card">
      <div className="row">
        <KeyRound size={16} className="tx-accent-icon" />
        <div className="col grow" style={{ gap: 2 }}>
          <strong>{k.name}</strong>
          <span className="faint">{k.type}{k.encrypted ? ' · защищён паролем' : ''} · {new Date(k.created).toLocaleDateString('ru-RU')}</span>
        </div>
        {k.encrypted && <Lock size={14} className="faint" />}
        <Button small icon={<Copy size={13} />} disabled={!k.publicKey} onClick={() => { api().clipboardWrite(k.publicKey); toast('Публичный ключ скопирован'); }}>Публичный ключ</Button>
        <Button small variant="danger" icon={<Trash size={13} />} onClick={() => setDialog({
          type: 'confirm', title: 'Удалить ключ?', text: `Ключ «${k.name}» будет удалён с этого компьютера. Серверы, использующие его, перестанут подключаться.`,
          confirmLabel: 'Удалить', danger: true,
          onConfirm: () => void api().deleteKey(k.id).then(() => toast('Ключ удалён')).catch((err) => toast(errorText(err), 'error')),
        })} />
      </div>
      {k.publicKey && <div className="tx-key-pub mono ellipsis" title={k.publicKey}>{k.publicKey}</div>}
      <div className="row">
        <Select className="grow" value={target} onChange={setTarget}
          options={[{ value: '', label: 'Установить на сервер…' }, ...hosts.filter((h) => h.protocol !== 'rdp').map((h) => ({ value: h.id, label: `${h.name || h.hostname} (${h.username}@${h.hostname})` }))]} />
        <Button small disabled={!target || busy} onClick={() => void install()}>{busy ? <Spinner size={13} /> : <Send size={13} />} Установить</Button>
      </div>
    </div>
  );
}

function Keys() {
  const keys = useApp((s) => s.data?.keys) ?? [];
  const [mode, setMode] = useState<'none' | 'generate' | 'paste'>('none');
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [pem, setPem] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setMode('none'); setName(''); setPassphrase(''); setPem(''); };
  const generate = async () => {
    setBusy(true);
    try {
      const item = await api().generateKey(name.trim() || 'termuxx', passphrase || undefined);
      api().clipboardWrite(item.publicKey);
      toast('Ключ Ed25519 создан, публичная часть скопирована', 'success');
      reset();
    } catch (err) { toast(errorText(err), 'error'); } finally { setBusy(false); }
  };
  const paste = async () => {
    setBusy(true);
    try {
      await api().importKey(name.trim() || 'Импортированный ключ', pem, passphrase || undefined);
      toast('Ключ импортирован', 'success');
      reset();
    } catch (err) { toast(errorText(err), 'error'); } finally { setBusy(false); }
  };
  const importFile = async () => {
    try {
      const item = await api().importKeyFile();
      if (item) toast(`Ключ «${item.name}» импортирован`, 'success');
    } catch (err) { toast(errorText(err), 'error'); }
  };

  return (
    <div className="tx-form">
      <div className="row">
        <h3 className="grow">SSH-ключи</h3>
        <Button small icon={<Wand2 size={13} />} onClick={() => setMode('generate')}>Создать Ed25519</Button>
        <Button small icon={<Upload size={13} />} onClick={() => void importFile()}>Из файла</Button>
        <Button small icon={<Pencil size={13} />} onClick={() => setMode('paste')}>Вставить</Button>
      </div>
      {mode !== 'none' && (
        <div className="card col">
          <Field label="Название ключа"><TextInput value={name} onChange={setName} placeholder={mode === 'generate' ? 'termuxx' : 'laptop'} autoFocus /></Field>
          {mode === 'paste' && (
            <Field label="Приватный ключ (OpenSSH или PEM)"><TextArea value={pem} onChange={setPem} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></Field>
          )}
          <Field label={mode === 'generate' ? 'Пароль для ключа (необязательно)' : 'Пароль ключа (если есть)'}>
            <TextInput type="password" value={passphrase} onChange={setPassphrase} autoComplete="new-password" />
          </Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button small onClick={reset}>Отмена</Button>
            {mode === 'generate'
              ? <Button small variant="primary" disabled={busy} onClick={() => void generate()}>Создать</Button>
              : <Button small variant="primary" disabled={busy || !pem.trim()} onClick={() => void paste()}>Импортировать</Button>}
          </div>
        </div>
      )}
      {keys.length === 0 && mode === 'none' && (
        <Empty icon={<KeyRound size={30} className="faint" />} title="Ключей пока нет">
          <span>Вход по ключу надёжнее пароля. Создайте ключ и установите его на сервер в один клик.</span>
        </Empty>
      )}
      {keys.map((k) => <KeyRow key={k.id} k={k} />)}
    </div>
  );
}

function SnippetEditor({ snippet, onDone }: { snippet: Snippet; onDone: () => void }) {
  const [draft, setDraft] = useState(snippet);
  const save = async () => {
    try {
      await api().saveSnippet({ ...draft, name: draft.name.trim() || draft.command.slice(0, 24) });
      onDone();
    } catch (err) { toast(errorText(err), 'error'); }
  };
  return (
    <div className="card col">
      <Field label="Название"><TextInput value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="Перезапуск прокси" autoFocus /></Field>
      <Field label="Команда"><TextArea value={draft.command} onChange={(v) => setDraft({ ...draft, command: v })} placeholder="systemctl restart mtproxy" /></Field>
      <Toggle checked={draft.runImmediately} onChange={(v) => setDraft({ ...draft, runImmediately: v })} label="Сразу выполнять (Enter)" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button small onClick={onDone}>Отмена</Button>
        <Button small variant="primary" disabled={!draft.command.trim()} onClick={() => void save()}>Сохранить</Button>
      </div>
    </div>
  );
}

function Snippets() {
  const snippets = useApp((s) => s.data?.snippets) ?? [];
  const [editing, setEditing] = useState<Snippet | null>(null);
  const setDialog = useApp((s) => s.setDialog);
  return (
    <div className="tx-form">
      <div className="row">
        <h3 className="grow">Сниппеты</h3>
        <Button small icon={<Plus size={13} />} onClick={() => setEditing({ id: newUUID(), name: '', command: '', runImmediately: true })}>Новый</Button>
      </div>
      {editing && <SnippetEditor snippet={editing} onDone={() => setEditing(null)} />}
      {snippets.length === 0 && !editing && (
        <Empty icon={<ListPlus size={30} className="faint" />} title="Сниппетов нет"><span>Сохраняйте частые команды и отправляйте их в терминал из строки состояния.</span></Empty>
      )}
      {snippets.map((s) => (
        <div key={s.id} className="tx-snippet list-row">
          <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <strong className="ellipsis">{s.name}</strong>
            <span className="mono faint ellipsis">{s.command}</span>
          </div>
          <Button small icon={<Send size={13} />} title="Отправить в активный терминал" onClick={() => {
            sendToPane(activePaneId(), s.command + (s.runImmediately ? '\r' : ''));
            setDialog(null);
          }}>В терминал</Button>
          <Button small icon={<Pencil size={13} />} onClick={() => setEditing(s)} />
          <Button small variant="danger" icon={<Trash size={13} />} onClick={() => void api().deleteSnippet(s.id).catch((err) => toast(errorText(err), 'error'))} />
        </div>
      ))}
    </div>
  );
}

function Backup() {
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [inspect, setInspect] = useState<{ path: string; preview: BackupPreview } | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const setDialog = useApp((s) => s.setDialog);

  const canExport = !includeSecrets || (password.length >= 6 && password === password2);
  const doExport = async () => {
    setBusy(true);
    try {
      const path = await api().backupExport(includeSecrets, includeSecrets ? password : undefined);
      if (path) {
        setLastExport(path);
        toast('Резервная копия сохранена', 'success');
      }
    } catch (err) { toast(errorText(err), 'error'); } finally { setBusy(false); }
  };
  const choose = async () => {
    try {
      const res = await api().backupInspect();
      if (res) { setInspect(res); setImportPassword(''); }
    } catch (err) { toast(errorText(err), 'error'); }
  };
  const doImport = async () => {
    if (!inspect) return;
    setBusy(true);
    try {
      const summary = await api().backupImport(inspect.path, inspect.preview.hasSecrets && importPassword ? importPassword : undefined);
      setInspect(null);
      setDialog({ type: 'summary', title: 'Импорт завершён', summary });
    } catch (err) { toast(errorText(err), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="tx-form">
      <h3>Экспорт</h3>
      <div className="tx-note">Файл .termuxx совместим с Termuxx для iPhone и Linux — так можно перенести серверы, ключи и сниппеты между устройствами.</div>
      <Toggle checked={includeSecrets} onChange={setIncludeSecrets} label="Включить пароли и ключи" hint="Секреты шифруются AES-256-GCM вашим паролем" />
      {includeSecrets && (
        <div className="tx-form-grid">
          <Field label="Пароль бэкапа" hint={password && password.length < 6 ? 'Минимум 6 символов' : undefined}>
            <TextInput type="password" value={password} onChange={setPassword} autoComplete="new-password" />
          </Field>
          <Field label="Повторите пароль" hint={password2 && password !== password2 ? 'Пароли не совпадают' : undefined}>
            <TextInput type="password" value={password2} onChange={setPassword2} autoComplete="new-password" />
          </Field>
        </div>
      )}
      <div className="row">
        <Button variant="primary" icon={<Download size={14} />} disabled={!canExport || busy} onClick={() => void doExport()}>Сохранить резервную копию…</Button>
        {lastExport && <Button icon={<FolderOpen size={14} />} onClick={() => api().showItemInFolder(lastExport)}>Показать в папке</Button>}
      </div>

      <h3>Импорт</h3>
      {!inspect ? (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button icon={<Upload size={14} />} onClick={() => void choose()}>Выбрать файл .termuxx…</Button>
          <Button onClick={() => void importSshConfig()}>Из ~/.ssh/config</Button>
          {api().platform === 'win32' && <Button onClick={() => void importPutty()}>Сессии PuTTY</Button>}
        </div>
      ) : (
        <div className="card col">
          <div className="row">
            <Archive size={16} className="tx-accent-icon" />
            <strong className="grow ellipsis" title={inspect.path}>{inspect.path.split(/[\\/]/).pop()}</strong>
            <span className="faint">{inspect.preview.app} · {new Date(inspect.preview.createdAt).toLocaleString('ru-RU')}</span>
          </div>
          <div className="row faint" style={{ flexWrap: 'wrap', gap: 14 }}>
            <span>{inspect.preview.hosts} {plural(inspect.preview.hosts, 'сервер', 'сервера', 'серверов')}</span>
            <span>{inspect.preview.keys} {plural(inspect.preview.keys, 'ключ', 'ключа', 'ключей')}</span>
            <span>{inspect.preview.snippets} {plural(inspect.preview.snippets, 'сниппет', 'сниппета', 'сниппетов')}</span>
            <span>{inspect.preview.hasSecrets ? 'с паролями и ключами' : 'без секретов'}</span>
          </div>
          {inspect.preview.hasSecrets && (
            <Field label="Пароль бэкапа" hint="Без пароля импортируются только серверы и сниппеты">
              <TextInput type="password" value={importPassword} onChange={setImportPassword} autoFocus />
            </Field>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button small onClick={() => setInspect(null)}>Отмена</Button>
            <Button small variant="primary" disabled={busy} onClick={() => void doImport()}>{busy ? <Spinner size={13} /> : null} Импортировать</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function About() {
  const [shortcuts] = useState([
    ['Ctrl+Shift+T', 'Новая вкладка (оболочка по умолчанию)'],
    ['Ctrl+Shift+W', 'Закрыть вкладку'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Следующая / предыдущая вкладка'],
    ['Ctrl+1…9', 'Перейти к вкладке'],
    ['Ctrl+Shift+D / E', 'Разделить вертикально / горизонтально'],
    ['Ctrl+Shift+B', 'SFTP-панель'],
    ['Ctrl+Shift+F', 'Поиск в терминале'],
    ['Ctrl+Shift+C / V', 'Копировать / вставить'],
    ['Ctrl+Shift+P', 'Палитра команд'],
    ['Ctrl+Shift+N', 'Новый сервер'],
    ['Ctrl+Shift+M', 'MultiExec'],
    ['Ctrl+= / Ctrl+− / Ctrl+0', 'Размер шрифта'],
    ['F11', 'Полный экран'],
  ]);
  useEffect(() => undefined, []);
  return (
    <div className="tx-form">
      <div className="tx-about">
        <div className="tx-logo big"><span className="tx-logo-chevron">&gt;</span><span className="tx-logo-xx">xx</span><span className="tx-logo-cursor" /></div>
        <div>
          <h2 style={{ margin: 0 }}>Termuxx для {api().platform === 'win32' ? 'Windows' : api().platform === 'darwin' ? 'macOS' : 'Linux'}</h2>
          <div className="muted">Версия {api().version} · SSH, SFTP, туннели, мониторинг</div>
          <div className="row" style={{ marginTop: 8 }}>
            <Button small onClick={() => api().openExternal('https://github.com/stillemptyNOW/termuxx')}>GitHub</Button>
            <span className="faint">Бесплатно, без рекламы и телеметрии · MIT</span>
          </div>
        </div>
      </div>
      <h3>Горячие клавиши</h3>
      <div className="tx-shortcuts">
        {shortcuts.map(([k, v]) => (
          <div key={k} className="row"><kbd className="tx-kbd">{k}</kbd><span className="muted">{v}</span></div>
        ))}
      </div>
    </div>
  );
}
