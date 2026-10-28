// Инструменты рабочей области (SFTP, мониторинг, туннели, передачи, запросы).
// Контракт для App (W3): имена и обязательные пропсы не меняются.
import './tools.css';

export { SftpPanel } from './SftpPanel';
export type { SftpPanelProps } from './SftpPanel';
export { MonitorBar } from './MonitorBar';
export type { MonitorBarProps } from './MonitorBar';
export { MonitorDialog } from './MonitorDialog';
export type { MonitorDialogProps } from './MonitorDialog';
export { TunnelsDialog, describeForward } from './TunnelsDialog';
export type { TunnelsDialogProps } from './TunnelsDialog';
/** Плавающая панель передач (сама подписывается на api.onTransfer). */
export { TransfersPanel } from './TransfersPanel';
/** Диалоги «Доверять ключу сервера?» и запросы пароля (сами подписываются на api.on*Prompt). */
export { PromptHost } from './PromptHost';
/** Встроенный редактор удалённого файла — можно открыть и из других мест (например, из терминала). */
export { EditorDialog } from './EditorDialog';
export type { EditorDialogProps } from './EditorDialog';
/** Подписка на мониторинг с подсчётом ссылок (бар + дашборд используют один опрос). */
export { useMonitor, acquireMonitor } from './stores';
