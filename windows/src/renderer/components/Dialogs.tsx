import React, { useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { DialogState } from '../state';
import { useApp } from '../state';
import { Button, Dialog, Field, TextInput } from '../ui/kit';
import { MonitorDialog, TunnelsDialog } from '../tools';
import { ServerEditor } from './ServerEditor';
import { SettingsDialog } from './SettingsDialog';
import { CommandPalette } from './CommandPalette';
import { saveServer } from './actions';

function ConfirmBox({ d, onClose }: { d: Extract<DialogState, { type: 'confirm' }>; onClose: () => void }) {
  return (
    <Dialog
      title={d.title}
      icon={d.danger ? <TriangleAlert size={18} color="var(--danger)" /> : undefined}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant={d.danger ? 'danger-solid' : 'primary'} autoFocus onClick={() => { onClose(); d.onConfirm(); }}>{d.confirmLabel}</Button>
        </>
      )}
    >
      <p style={{ margin: '4px 0 8px', lineHeight: 1.5 }}>{d.text}</p>
    </Dialog>
  );
}

function PromptBox({ d, onClose }: { d: Extract<DialogState, { type: 'prompt' }>; onClose: () => void }) {
  const [value, setValue] = useState(d.value);
  const submit = () => { onClose(); d.onSubmit(value); };
  return (
    <Dialog
      title={d.title}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" onClick={submit}>Готово</Button>
        </>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label={d.label}>
          <TextInput value={value} onChange={setValue} autoFocus list="tx-prompt-suggest" />
          {d.suggestions && d.suggestions.length > 0 && (
            <datalist id="tx-prompt-suggest">{d.suggestions.map((s) => <option key={s} value={s} />)}</datalist>
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function SummaryBox({ d, onClose }: { d: Extract<DialogState, { type: 'summary' }>; onClose: () => void }) {
  return (
    <Dialog
      title={d.title}
      icon={<CircleCheck size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Готово</Button>}
    >
      {d.summary.lines.length === 0 && d.summary.warnings.length === 0 && <p className="muted">Ничего не изменилось.</p>}
      {d.summary.lines.length > 0 && (
        <ul className="tx-summary">
          {d.summary.lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
      {d.summary.warnings.length > 0 && (
        <>
          <div className="section-title" style={{ paddingLeft: 0 }}>Предупреждения</div>
          <ul className="tx-summary warn">
            {d.summary.warnings.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </>
      )}
    </Dialog>
  );
}

/** Отрисовывает текущий диалог из состояния приложения. */
export function DialogHost() {
  const dialog = useApp((s) => s.dialog);
  const setDialog = useApp((s) => s.setDialog);
  const server = useApp((s) => (dialog && (dialog.type === 'monitor' || dialog.type === 'tunnels') ? s.server(dialog.serverId) : undefined));
  const close = () => setDialog(null);
  if (!dialog) return null;
  switch (dialog.type) {
    case 'server':
      return <ServerEditor key={dialog.serverId ?? 'new'} serverId={dialog.serverId} initial={dialog.initial} onClose={close} />;
    case 'settings':
      return <SettingsDialog section={dialog.section} onClose={close} />;
    case 'monitor':
      return server ? <MonitorDialog sessionId={dialog.sessionId} server={server} onClose={close} /> : null;
    case 'tunnels':
      return server
        ? <TunnelsDialog sessionId={dialog.sessionId} server={server} onClose={close} onSaveServer={(s) => void saveServer(s)} />
        : null;
    case 'palette':
      return <CommandPalette onClose={close} />;
    case 'summary':
      return <SummaryBox d={dialog} onClose={close} />;
    case 'confirm':
      return <ConfirmBox d={dialog} onClose={close} />;
    case 'prompt':
      return <PromptBox d={dialog} onClose={close} />;
    default:
      return null;
  }
}
