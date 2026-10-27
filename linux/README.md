<p align="center"><img src="data/icons/hicolor/256x256/apps/com.stillempty.Termuxx.png" width="128" alt="Termuxx"></p>

# Termuxx для Linux

Нативное приложение для Arch Linux (GTK 4 + libadwaita + VTE): терминал с вкладками и менеджер SSH-серверов.
Работает и в GNOME, и в KDE, и в тайловых WM. Резервная копия совместима с Termuxx для iPhone —
серверы, ключи и сниппеты переносятся в обе стороны.

## Возможности

- **Терминал** на VTE (как в GNOME Terminal): вкладки, обзор вкладок, разделение экрана, поиск, ссылки по Ctrl+щелчку,
  6 тем (как на iPhone), любой моноширинный шрифт, масштаб, история прокрутки.
- **Серверы**: список слева с поиском и цветными метками, быстрое подключение `user@host:port`,
  открытие ссылок `ssh://` из браузера.
- **SSH через системный OpenSSH**: работает ваш `~/.ssh/config`, агент, известные ключи серверов.
  Сохранённые пароли вводятся сами (нужен `sshpass`), при первом подключении ssh спросит про ключ сервера прямо в терминале.
- **Надёжность**: keep-alive, автоматическое переподключение после обрыва (до 3 попыток), режим **tmux** —
  после переподключения вы попадаете ровно туда, где были.
- **Подключение через** промежуточный сервер (jump host) или **SOCKS5-прокси**.
- **Проброс портов**: правила хранятся в сервере и открываются вместе с SSH-сессией (`ssh -L`)
  или вручную в окне «Туннели».
- **Файлы (SFTP)**, **мониторинг** (CPU, память, диски, сеть, процессы, сервисы systemd, Docker) и **туннели** — отдельные окна.
- **Ключи**: создание Ed25519, импорт из файла или буфера (в том числе с паролем), установка на сервер через `ssh-copy-id`
  с автоматическим переключением сервера на вход по ключу.
- **Сниппеты**: частые команды в одно нажатие, команда при входе на сервер.
- **Секреты** хранятся в системном хранилище паролей (GNOME Keyring / KWallet через libsecret).
  Если его нет — в `~/.local/share/termuxx/secrets.json` с правами 0600.
- **Резервная копия** `.termuxx`: пароли и ключи шифруются AES-256-GCM (формат — [docs/BACKUP_FORMAT.md](../docs/BACKUP_FORMAT.md)).

## Установка

### Из этого репозитория (makepkg)

```bash
git clone https://github.com/stillemptyNOW/termuxx.git
cd termuxx/linux/packaging
makepkg -si
```

PKGBUILD собирает пакет `termuxx-git` из свежего коммита `main`. Готовый пакет `.pkg.tar.zst`
также прикладывается к каждому релизу на GitHub: `sudo pacman -U termuxx-git-*.pkg.tar.zst`.

Рекомендуемые дополнительные пакеты:

```bash
sudo pacman -S --needed sshpass openbsd-netcat gnome-keyring
```

- `sshpass` — автоматический ввод сохранённых паролей;
- `openbsd-netcat` (или `nmap` для `ncat`) — подключение через SOCKS5-прокси;
- `gnome-keyring` или KWallet — системное хранилище паролей.

### Запуск без установки

```bash
cd termuxx/linux
python -m termuxx
```

Зависимости: `python-gobject gtk4 libadwaita vte4 python-paramiko python-cryptography libsecret openssh`.

## Горячие клавиши

| Клавиши | Действие |
|---|---|
| Ctrl+Shift+T | Новая вкладка (локальный терминал) |
| Ctrl+Shift+W | Закрыть вкладку |
| Ctrl+PgUp / Ctrl+PgDn, Alt+1…9 | Переключение вкладок |
| Ctrl+Shift+E / Ctrl+Shift+O | Разделить экран по горизонтали / вертикали |
| Ctrl+Shift+X | Закрыть панель |
| Ctrl+Shift+C / Ctrl+Shift+V | Копировать / вставить |
| Ctrl+Shift+F | Поиск в терминале |
| Ctrl+= / Ctrl+- / Ctrl+0 | Масштаб |
| Ctrl+Shift+R | Переподключить SSH |
| Ctrl+Shift+K | Быстрое подключение |
| Ctrl+Shift+S | Сниппеты |
| Ctrl+Shift+N | Новое окно |
| F9 | Показать / скрыть панель серверов |
| F11 | Во весь экран |
| Ctrl+, | Параметры |

## Командная строка

```bash
termuxx                         # открыть окно
termuxx ssh://root@203.0.113.10 # сразу подключиться
termuxx --ssh admin@host:2222
termuxx --new-window
termuxx --smoke-test            # проверка для CI: окно + терминал, выход через 2 с
```

## Где лежат данные

| Что | Где |
|---|---|
| Серверы, ключи (метаданные), сниппеты | `~/.config/termuxx/termuxx.json` |
| Настройки | `~/.config/termuxx/settings.json` |
| Пароли и приватные ключи | системное хранилище паролей (схема `com.stillempty.termuxx`) |
| Файлы ключей для ssh | `~/.local/share/termuxx/keys/<id>` (0600) |
