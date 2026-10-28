// Общие действия интерфейса (используются боковой панелью, главной, палитрой и меню).
import type { ImportSummary, Server } from '../../shared/types';
import { blankServer, errorText, newUUID, parseQuickConnect, sshCommand, useApp } from '../state';
import { toast } from '../ui/kit';
import { openServer } from './sessions';

const api = () => window.termuxx;

/** «user@host:port» → найти или создать сервер и подключиться. */
export async function quickConnect(text: string): Promise<boolean> {
  const parsed = parseQuickConnect(text);
  if (!parsed) {
    toast('Не понял адрес. Формат: user@host:port', 'error');
    return false;
  }
  const st = useApp.getState();
  const hosts = st.data?.hosts ?? [];
  let server = hosts.find((h) => h.hostname.toLowerCase() === parsed.hostname.toLowerCase()
    && h.port === parsed.port && h.username === parsed.username);
  if (!server) {
    server = blankServer({ name: parsed.hostname, hostname: parsed.hostname, port: parsed.port, username: parsed.username });
    try {
      await api().saveServer(server);
    } catch (err) {
      toast(errorText(err), 'error');
      return false;
    }
    const data = useApp.getState().data;
    if (data && !data.hosts.some((h) => h.id === server!.id)) {
      useApp.getState().setData({ ...data, hosts: [...data.hosts, server] });
    }
  }
  st.rememberQuick(text.trim());
  await openServer(server);
  return true;
}

export async function saveServer(server: Server) {
  try {
    await api().saveServer(server);
    const data = useApp.getState().data;
    if (data) {
      const exists = data.hosts.some((h) => h.id === server.id);
      useApp.getState().setData({
        ...data,
        hosts: exists ? data.hosts.map((h) => (h.id === server.id ? server : h)) : [...data.hosts, server],
      });
    }
  } catch (err) {
    toast(errorText(err), 'error');
    throw err;
  }
}

export async function duplicateServer(server: Server) {
  const copy: Server = {
    ...server,
    id: newUUID(),
    name: `${server.name || server.hostname} (копия)`,
    lastConnected: null,
    forwards: server.forwards.map((f) => ({ ...f, id: newUUID() })),
  };
  await saveServer(copy);
  toast('Сервер скопирован (пароль нужно ввести заново)', 'success');
}

export function confirmDeleteServer(server: Server) {
  useApp.getState().setDialog({
    type: 'confirm',
    title: 'Удалить сервер?',
    text: `«${server.name || server.hostname}» и сохранённый пароль будут удалены. Открытые вкладки останутся.`,
    confirmLabel: 'Удалить',
    danger: true,
    onConfirm: () => {
      void api().deleteServer(server.id).then(() => {
        const data = useApp.getState().data;
        if (data) useApp.getState().setData({ ...data, hosts: data.hosts.filter((h) => h.id !== server.id) });
        toast('Сервер удалён');
      }).catch((err) => toast(errorText(err), 'error'));
    },
  });
}

export function copySshCommand(server: Server) {
  const st = useApp.getState();
  const jump = server.jumpHostID ? st.server(server.jumpHostID) : undefined;
  api().clipboardWrite(sshCommand(server, jump));
  toast('Команда ssh скопирована');
}

export async function moveServerToGroup(server: Server, group: string | null) {
  const g = group?.trim() || null;
  if ((server.group ?? null) === g) return;
  await saveServer({ ...server, group: g });
}

function showSummary(title: string, summary: ImportSummary) {
  useApp.getState().setDialog({ type: 'summary', title, summary });
}

export async function importSshConfig() {
  try {
    showSummary('Импорт из ~/.ssh/config', await api().importSshConfig());
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

export async function importPutty() {
  try {
    showSummary('Импорт сессий PuTTY', await api().importPutty());
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

export function askFolder(server: Server) {
  const st = useApp.getState();
  st.setDialog({
    type: 'prompt',
    title: 'Переместить в папку',
    label: 'Название папки (пусто — без папки)',
    value: server.group ?? '',
    suggestions: [...new Set((st.data?.hosts ?? []).map((h) => h.group).filter((g): g is string => !!g))],
    onSubmit: (v) => void moveServerToGroup(server, v),
  });
}
