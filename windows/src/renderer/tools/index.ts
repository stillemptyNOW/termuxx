// Инструменты рабочей области (SFTP, мониторинг, туннели, передачи, запросы).
// ЗАГЛУШКИ: реализацию пишет отдельный агент, сигнатуры — контракт для App.
import type { Server } from '../../shared/types';

export interface SftpPanelProps { sessionId: string; server: Server; connected: boolean; onClose?: () => void }
export interface MonitorBarProps { sessionId: string; onOpenDashboard: () => void }
export interface MonitorDialogProps { sessionId: string; server: Server; onClose: () => void }
export interface TunnelsDialogProps { sessionId: string; server: Server; onClose: () => void; onSaveServer: (s: Server) => void }

export function SftpPanel(_: SftpPanelProps): JSX.Element | null { return null; }
export function MonitorBar(_: MonitorBarProps): JSX.Element | null { return null; }
export function MonitorDialog(_: MonitorDialogProps): JSX.Element | null { return null; }
export function TunnelsDialog(_: TunnelsDialogProps): JSX.Element | null { return null; }
/** Плавающая панель передач (сама подписывается на api.onTransfer). */
export function TransfersPanel(): JSX.Element | null { return null; }
/** Диалоги «Доверять ключу сервера?» и запросы пароля (сами подписываются на api.on*Prompt). */
export function PromptHost(): JSX.Element | null { return null; }
