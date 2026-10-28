// Локальные оболочки: PowerShell, cmd, WSL, Git Bash (Windows) или $SHELL/bash/zsh (Linux, macOS).
import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ShellInfo } from '../shared/types';
import type { LocalSessionRequest, MainContext, SessionEmitter, SessionHandle } from './contracts';

const isWin = process.platform === 'win32';
let cache: { at: number; shells: ShellInfo[] } | null = null;

function exists(p: string | undefined | null): p is string {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findInPath(exe: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir.replace(/^"|"$/g, ''), exe);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function run(file: string, args: string[], timeout = 6000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'buffer', timeout, windowsHide: true }, (err, stdout) => {
      resolve(err && !stdout?.length ? null : (stdout as Buffer));
    });
  });
}

/** wsl.exe печатает список в UTF-16LE (если не задан WSL_UTF8=1). */
export function decodeWslList(buf: Buffer): string[] {
  let zeros = 0;
  for (let i = 1; i < Math.min(buf.length, 200); i += 2) if (buf[i] === 0) zeros++;
  const text = zeros > 2 ? buf.toString('utf16le') : buf.toString('utf8');
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^docker-desktop/i.test(s));
}

async function detectWindowsShells(): Promise<ShellInfo[]> {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const shells: ShellInfo[] = [];

  const pwsh = findInPath('pwsh.exe')
    ?? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    ].find(exists)
    ?? null;
  if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', command: pwsh, args: ['-NoLogo'], icon: 'powershell' });

  const winPs = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (exists(winPs)) shells.push({ id: 'powershell', name: 'Windows PowerShell', command: winPs, args: ['-NoLogo'], icon: 'powershell' });

  const cmd = process.env.ComSpec && exists(process.env.ComSpec) ? process.env.ComSpec : path.join(sysRoot, 'System32', 'cmd.exe');
  if (exists(cmd)) shells.push({ id: 'cmd', name: 'Командная строка', command: cmd, args: [], icon: 'cmd' });

  const wsl = path.join(sysRoot, 'System32', 'wsl.exe');
  if (exists(wsl)) {
    const out = await run(wsl, ['-l', '-q']);
    const distros = out ? decodeWslList(out) : [];
    for (const name of distros) {
      shells.push({ id: `wsl:${name}`, name: `WSL: ${name}`, command: wsl, args: ['-d', name, '--cd', '~'], icon: 'linux' });
    }
  }

  const gitBash = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(os.homedir(), 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
  ].find(exists);
  if (gitBash) shells.push({ id: 'gitbash', name: 'Git Bash', command: gitBash, args: ['--login', '-i'], icon: 'git' });

  return shells;
}

function detectUnixShells(): ShellInfo[] {
  const shells: ShellInfo[] = [];
  const seen = new Set<string>();
  const add = (file: string | undefined, id: string, name: string) => {
    if (!exists(file)) return;
    let real = file;
    try { real = fs.realpathSync(file); } catch { /* ignore */ }
    if (seen.has(real)) return;
    seen.add(real);
    shells.push({ id, name, command: file, args: ['-l'], icon: 'terminal' });
  };
  const userShell = process.env.SHELL;
  if (userShell) add(userShell, path.basename(userShell), `${path.basename(userShell)} (по умолчанию)`);
  add('/bin/bash', 'bash', 'bash');
  add('/usr/bin/zsh', 'zsh', 'zsh');
  add('/bin/zsh', 'zsh', 'zsh');
  add('/usr/bin/fish', 'fish', 'fish');
  add('/bin/sh', 'sh', 'sh');
  return shells;
}

export async function listShells(): Promise<ShellInfo[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.shells;
  const shells = isWin ? await detectWindowsShells() : detectUnixShells();
  cache = { at: Date.now(), shells };
  return shells;
}

function clampSize(n: number, def: number): number {
  return Number.isFinite(n) && n >= 2 ? Math.min(Math.floor(n), 1000) : def;
}

export async function createPtySession(
  ctx: MainContext,
  req: LocalSessionRequest,
  sessionId: string,
  emit: SessionEmitter,
): Promise<SessionHandle> {
  const shells = await listShells();
  const preferred = req.shellId || ctx.store.settings().defaultShellID || '';
  const shell = shells.find((s) => s.id === preferred) ?? shells[0];
  if (!shell) throw new Error('Не найдено ни одной локальной оболочки.');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Termuxx';
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  let cwd = os.homedir();
  if (req.cwd) {
    try {
      if (fs.statSync(req.cwd).isDirectory()) cwd = req.cwd;
    } catch { /* ignore */ }
  }

  const options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions = {
    name: 'xterm-256color',
    cols: clampSize(req.cols, 80),
    rows: clampSize(req.rows, 24),
    cwd,
    env,
    ...(isWin ? { useConpty: true } : {}),
  };

  let proc: pty.IPty;
  try {
    proc = pty.spawn(shell.command, shell.args, options);
  } catch (err) {
    throw new Error(`Не удалось запустить ${shell.name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let exited = false;
  proc.onData((d) => emit.data(d));
  proc.onExit(({ exitCode }) => {
    exited = true;
    emit.status({
      status: 'closed',
      exitCode,
      message: exitCode === 0 ? undefined : `Процесс завершился с кодом ${exitCode}`,
    });
  });
  emit.status({ status: 'connected', message: shell.name });

  return {
    id: sessionId,
    kind: 'local',
    write(data: string) {
      if (!exited) proc.write(data);
    },
    resize(cols: number, rows: number) {
      if (exited) return;
      try {
        proc.resize(clampSize(cols, 80), clampSize(rows, 24));
      } catch { /* процесс мог уже завершиться */ }
    },
    close() {
      if (exited) return;
      exited = true;
      try {
        proc.kill();
      } catch { /* ignore */ }
    },
    async remoteCwd() {
      return null;
    },
  };
}
