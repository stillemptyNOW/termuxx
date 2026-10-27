// Базовые UI-компоненты Termuxx для Windows. Используются всеми экранами.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------- Кнопки ----------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'danger-solid' | 'ghost';
  small?: boolean;
  icon?: React.ReactNode;
};

export function Button({ variant = 'default', small, icon, className, children, ...rest }: ButtonProps) {
  const v = variant === 'danger-solid' ? 'danger solid' : variant === 'default' ? '' : variant;
  return (
    <button className={cx('btn', v, small && 'small', className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ title, active, className, children, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button title={title} aria-label={title} className={cx('icon-btn', active && 'active', className)} {...rest}>
      {children}
    </button>
  );
}

// ---------- Поля ----------

export function Field({ label, hint, children }: { label?: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function TextInput({ value, onChange, className, ...rest }:
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & { value: string; onChange: (v: string) => void }) {
  return <input className={cx('input', className)} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...rest} />;
}

export function NumberInput({ value, onChange, min, max, className, ...rest }:
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <input
      type="number"
      className={cx('input', className)}
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      {...rest}
    />
  );
}

export function TextArea({ value, onChange, className, ...rest }:
  Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & { value: string; onChange: (v: string) => void }) {
  return <textarea className={cx('textarea', className)} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...rest} />;
}

export function Select<T extends string>({ value, onChange, options, className }:
  { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <select className={cx('select', className)} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: string; hint?: string }) {
  const control = (
    <span className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="knob" />
    </span>
  );
  if (!label) return <label>{control}</label>;
  return (
    <label className="row" style={{ justifyContent: 'space-between', padding: '6px 0', cursor: 'pointer' }}>
      <span className="col" style={{ gap: 2 }}>
        <span>{label}</span>
        {hint && <span className="faint" style={{ fontSize: 11 }}>{hint}</span>}
      </span>
      {control}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options }:
  { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode }[] }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={cx(o.value === value && 'on')} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <div className="spinner" style={{ width: size, height: size }} />;
}

export function Progress({ value }: { value: number }) {
  return <div className="progress"><div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>;
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div className="title">{title}</div>
      {children}
    </div>
  );
}

// ---------- Диалог ----------

export function Dialog({ title, onClose, children, footer, size, icon }: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'normal' | 'wide' | 'full';
  icon?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cx('dialog', size === 'wide' && 'wide', size === 'full' && 'full')} role="dialog">
        <div className="dialog-header">
          {icon}
          <h2>{title}</h2>
          <IconButton title="Закрыть" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Контекстное меню ----------

export interface MenuItem {
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

interface MenuState { x: number; y: number; items: MenuItem[] }
const useMenuStore = create<{ menu: MenuState | null; set: (m: MenuState | null) => void }>((set) => ({
  menu: null,
  set: (menu) => set({ menu }),
}));

/** Открыть контекстное меню в точке события. */
export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  useMenuStore.getState().set({ x: e.clientX, y: e.clientY, items });
}

export function MenuHost() {
  const menu = useMenuStore((s) => s.menu);
  const close = useMenuStore((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const hide = () => close(null);
    window.addEventListener('mousedown', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('mousedown', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
    };
  }, [menu, close]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={ref}
      className="menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.items.map((item, i) => item.separator
        ? <div key={i} className="menu-sep" />
        : (
          <div
            key={i}
            className={cx('menu-item', item.danger && 'danger')}
            style={item.disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
            onClick={() => { close(null); item.onClick?.(); }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
          </div>
        ))}
    </div>,
    document.body,
  );
}

// ---------- Уведомления ----------

interface ToastItem { id: number; text: string; kind: 'info' | 'error' | 'success' }
const useToastStore = create<{ toasts: ToastItem[]; push: (t: Omit<ToastItem, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.kind === 'error' ? 7000 : 3500);
  },
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export function toast(text: string, kind: ToastItem['kind'] = 'info') {
  useToastStore.getState().push({ text, kind });
}

export function toastError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // ipcRenderer.invoke оборачивает ошибки: "Error invoking remote method 'x': Error: текст"
  toast(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
}

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const drop = useToastStore((s) => s.drop);
  return createPortal(
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast glass', t.kind === 'error' && 'error')} onClick={() => drop(t.id)}>
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------- Форматирование ----------

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
