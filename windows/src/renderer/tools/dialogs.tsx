// Небольшие диалоги инструментов: ввод имени, подтверждение, права доступа, просмотр логов.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, ScrollText, Shield } from 'lucide-react';
import { Button, Dialog, TextInput, Toggle, toast } from '../ui/kit';
import { api, modeString, octal } from './util';

export function NameDialog({ title, label, initial, confirmText, validate, onSubmit, onClose, selectBaseName }: {
  title: string;
  label: string;
  initial: string;
  confirmText: string;
  validate?: (v: string) => string | null;
  onSubmit: (v: string) => void | Promise<void>;
  onClose: () => void;
  /** Выделить имя без расширения (как в Проводнике). */
  selectBaseName?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const error = validate ? validate(value) : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    if (selectBaseName && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial, selectBaseName]);

  const submit = async () => {
    if (error || busy) return;
    setBusy(true);
    try {
      await onSubmit(value.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="primary" disabled={!!error || busy} onClick={() => void submit()}>{confirmText}</Button>
      </>}
    >
      <div className="field">
        <label>{label}</label>
        <input
          ref={ref}
          className="input"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        />
        {error && value !== initial && <div className="hint tx-error-text">{error}</div>}
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({ title, message, confirmText, danger, onConfirm, onClose, children }: {
  title: string;
  message: React.ReactNode;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Отмена</Button>
        <Button
          variant={danger ? 'danger-solid' : 'primary'}
          disabled={busy}
          autoFocus
          onClick={async () => {
            setBusy(true);
            try { await onConfirm(); } finally { setBusy(false); }
          }}
        >
          {confirmText}
        </Button>
      </>}
    >
      <div className="col">
        <div>{message}</div>
        {children}
      </div>
    </Dialog>
  );
}

const WHO = [
  { key: 'owner', label: 'Владелец', shift: 6 },
  { key: 'group', label: 'Группа', shift: 3 },
  { key: 'other', label: 'Остальные', shift: 0 },
] as const;
const BITS = [
  { label: 'Чтение', bit: 4 },
  { label: 'Запись', bit: 2 },
  { label: 'Выполнение', bit: 1 },
] as const;

export function ChmodDialog({ names, mode: initialMode, isDir, onApply, onClose }: {
  names: string[];
  mode: number;
  isDir: boolean;
  onApply: (mode: number) => void | Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode & 0o7777);
  const [octalText, setOctalText] = useState(octal(initialMode));
  const [busy, setBusy] = useState(false);

  const toggle = (shift: number, bit: number) => {
    const m = mode ^ (bit << shift);
    setMode(m);
    setOctalText(octal(m));
  };

  const onOctal = (v: string) => {
    setOctalText(v);
    if (/^[0-7]{3,4}$/.test(v)) setMode(parseInt(v, 8));
  };

  const valid = /^[0-7]{3,4}$/.test(octalText);
  const title = names.length === 1 ? `Права: ${names[0]}` : `Права: ${names.length} объектов`;

  return (
    <Dialog
      title={title}
      icon={<Shield size={18} className="tx-accent" />}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Отмена</Button>
        <Button
          variant="primary"
          disabled={!valid || busy}
          onClick={async () => { setBusy(true); try { await onApply(mode); } finally { setBusy(false); } }}
        >
          Применить
        </Button>
      </>}
    >
      <table className="tx-chmod">
        <thead>
          <tr><th />{BITS.map((b) => <th key={b.bit}>{b.label}</th>)}</tr>
        </thead>
        <tbody>
          {WHO.map((w) => (
            <tr key={w.key}>
              <td>{w.label}</td>
              {BITS.map((b) => (
                <td key={b.bit}>
                  <input
                    type="checkbox"
                    className="tx-check"
                    checked={((mode >> w.shift) & b.bit) !== 0}
                    onChange={() => toggle(w.shift, b.bit)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 12 }}>
        <div className="field" style={{ width: 120 }}>
          <label>Восьмеричный</label>
          <TextInput className="mono" value={octalText} onChange={onOctal} maxLength={4} />
        </div>
        <div className="field grow">
          <label>Символьный</label>
          <div className="mono tx-mode-preview">{modeString(mode, isDir, false)}</div>
        </div>
      </div>
      {!valid && <div className="hint tx-error-text">Введите 3–4 восьмеричные цифры, например 644 или 0755</div>}
    </Dialog>
  );
}

export function LogDialog({ title, text, loading, onClose, onRefresh }: {
  title: string;
  text: string;
  loading?: boolean;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const [wrap, setWrap] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => text.split('\n').length, [text]);
  useEffect(() => {
    // Логи читаются с конца — прокручиваем вниз.
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <Dialog
      title={title}
      icon={<ScrollText size={18} className="tx-accent" />}
      size="wide"
      onClose={onClose}
      footer={<>
        <div className="row grow">
          <Toggle checked={wrap} onChange={setWrap} />
          <span className="muted">Переносить строки</span>
          <span className="faint" style={{ marginLeft: 12 }}>{lines} строк</span>
        </div>
        {onRefresh && <Button onClick={onRefresh} disabled={loading}>Обновить</Button>}
        <Button icon={<Copy size={14} />} onClick={() => { api().clipboardWrite(text); toast('Скопировано'); }}>Копировать</Button>
        <Button variant="primary" onClick={onClose}>Закрыть</Button>
      </>}
    >
      <pre ref={ref} className={wrap ? 'tx-log wrap' : 'tx-log'}>{loading ? 'Загрузка…' : (text.trim() || 'Пусто')}</pre>
    </Dialog>
  );
}
