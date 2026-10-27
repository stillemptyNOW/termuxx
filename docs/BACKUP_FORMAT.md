# Формат резервной копии Termuxx (`.termuxx`)

Общий формат для Termuxx на iOS/iPadOS (`Termuxx/Backup/Backup.swift`) и Termuxx для Linux.
Эталонная реализация и самопроверка: `scripts/backup_tool.py` (`python3 scripts/backup_tool.py selftest`).

- Файл: UTF-8 JSON, расширение `.termuxx`, имя по умолчанию `termuxx-backup-ГГГГ-ММ-ДД.termuxx`.
- Версия формата: `1`. Читатель **должен** отказать, если `version` больше поддерживаемой, и **должен** игнорировать незнакомые поля.
- Порядок ключей не важен (iOS пишет с `sortedKeys`).

## Корневой объект

```json
{
  "format": "termuxx-backup",
  "version": 1,
  "app": "ios",
  "createdAt": "2026-10-27T10:00:00Z",
  "hosts": [ … ],
  "keys": [ … ],
  "snippets": [ … ],
  "knownHosts": { "203.0.113.10:22": "ssh-ed25519 SHA256:…" },
  "secrets": null
}
```

| Поле | Тип | Описание |
|---|---|---|
| `format` | string | Всегда `"termuxx-backup"`. Иначе это не бэкап. |
| `version` | int | `1`. |
| `app` | string | Кто создал: `"ios"` или `"linux"`. |
| `createdAt` | string | ISO 8601 в UTC **без долей секунды**: `2026-10-27T10:00:00Z`. |
| `hosts` | array | Серверы, см. ниже. |
| `keys` | array | Метаданные SSH-ключей (без приватной части). |
| `snippets` | array | Сниппеты. |
| `knownHosts` | object | Отпечатки ключей серверов: `"host:port"` → отпечаток. |
| `secrets` | object \| null | Зашифрованные пароли и приватные ключи. `null` — секретов нет. |

### Идентификаторы и даты

- Все `id` — UUID **в верхнем регистре** (`"65745A5E-5957-440E-8719-E09A78EA3357"`), как пишет Swift.
  Читатель сравнивает без учёта регистра (Python: `str(uuid.uuid4()).upper()`).
- Даты — ISO 8601, `Z` или смещение (`+03:00`). Писать без долей секунды: стандартный
  `JSONDecoder.iso8601` на iOS не читает `.123`. iOS при чтении понимает оба варианта.
- Python: `datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")`.

### `hosts[]`

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `id` | string (UUID) | — | Обязательно. |
| `name` | string | `""` | Название (пусто → показывается `hostname`). |
| `hostname` | string | — | IP или домен. Обязательно. |
| `port` | int | `22` | |
| `username` | string | `"root"` | |
| `auth` | string | `"password"` | `"password"` или `"key"`. |
| `keyID` | string? | нет | `id` ключа из `keys[]` (для `auth = "key"`). |
| `startupSnippetID` | string? | нет | Сниппет, выполняемый при входе. |
| `colorHex` | string | `"#3DDC97"` | Цвет карточки. |
| `lastConnected` | string? | нет | Дата последнего подключения. |
| `useTmux` | bool | `false` | Входить в `tmux new -A -s termuxx`. |
| `autoReconnect` | bool | `true` | Переподключаться после обрыва. |
| `keepAlive` | bool | `true` | TCP keep-alive. |
| `jumpHostID` | string? | нет | `id` промежуточного сервера (ProxyJump). |
| `proxy` | object? | нет | SOCKS5: `{"host": "127.0.0.1", "port": 1080, "username": ""}`. Пароль — в `secrets.proxyPasswords`. |
| `forwards` | array | `[]` | Локальные пробросы портов (ниже). |

Отсутствующие необязательные поля пишутся как «нет ключа» (iOS опускает `null`-поля внутри объектов).

`forwards[]`: `{"id", "name", "localPort", "remoteHost", "remotePort", "autoStart"}` —
`127.0.0.1:localPort` на устройстве → `remoteHost:remotePort` со стороны сервера (`ssh -L`).

### `keys[]`

| Поле | Тип | Описание |
|---|---|---|
| `id` | string (UUID) | |
| `name` | string | |
| `type` | string | `"ED25519"` или `"RSA"`. |
| `publicKey` | string | Строка OpenSSH: `ssh-ed25519 AAAA… комментарий` (для RSA может быть пустой). |
| `created` | string | Дата создания. |
| `encrypted` | bool | Приватный ключ защищён паролем (passphrase). |

Сам приватный ключ (OpenSSH PEM, `-----BEGIN OPENSSH PRIVATE KEY-----`) хранится только в `secrets.privateKeys`.

### `snippets[]`

`{"id", "name", "command", "runImmediately"}` — `runImmediately: true` значит «отправить с Enter».

### `knownHosts`

Ключ — `"<hostname в нижнем регистре>:<port>"`, значение — `"<тип ключа> SHA256:<base64 без '='>"`
(как `ssh-keygen -lf`, например `ssh-ed25519 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s`).
При импорте iOS **не перезаписывает** уже сохранённые отпечатки, а только добавляет новые.

## Секция `secrets`

```json
"secrets": {
  "kdf": "pbkdf2-sha256",
  "iterations": 200000,
  "salt": "<base64, 16 байт>",
  "cipher": "aes-256-gcm",
  "nonce": "<base64, 12 байт>",
  "data": "<base64: ciphertext || tag (16 байт)>"
}
```

Открытый текст — JSON (UTF-8):

```json
{
  "passwords":      { "<hostID>": "пароль сервера" },
  "proxyPasswords": { "<hostID>": "пароль SOCKS5" },
  "privateKeys":    { "<keyID>":  "-----BEGIN OPENSSH PRIVATE KEY-----\n…" },
  "passphrases":    { "<keyID>":  "пароль от ключа" }
}
```

Ключи словарей — `id` в верхнем регистре. Пустые разделы допустимы. Если секретов нет совсем, пишется `"secrets": null`.

### Криптография (точно)

1. Пароль бэкапа → Unicode **NFC** → байты **UTF-8**.
2. `salt` — 16 случайных байт, `nonce` — 12 случайных байт (новые при каждом экспорте).
3. Ключ: `PBKDF2-HMAC-SHA256(password, salt, iterations = 200000, dkLen = 32)`.
4. Шифрование: `AES-256-GCM(key, nonce, plaintext)`, **без AAD**, тег 16 байт.
5. `data = base64(ciphertext || tag)` — ровно то, что возвращает `AESGCM(key).encrypt(nonce, pt, None)` в Python.
6. base64 — стандартный алфавит с паддингом `=`.

Неверный пароль обнаруживается проверкой тега GCM (ошибка «Неверный пароль бэкапа»). Читатель принимает
`iterations` из файла (1…10 000 000), так что число итераций можно поднять, не меняя версию формата.

Python:

```python
import base64, hashlib, unicodedata
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def derive(password, salt, iterations):
    pw = unicodedata.normalize("NFC", password).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", pw, salt, iterations, dklen=32)

def decrypt(sec, password):
    key = derive(password, base64.b64decode(sec["salt"]), int(sec["iterations"]))
    return AESGCM(key).decrypt(base64.b64decode(sec["nonce"]), base64.b64decode(sec["data"]), None)
```

Swift (iOS): `CCKeyDerivationPBKDF(kCCPBKDF2, …, kCCPRFHmacAlgSHA256, 200000, …, 32)` + `AES.GCM.seal` / `AES.GCM.open`
(`SealedBox(nonce:ciphertext:tag:)`, `ciphertext + tag`).

### Тестовый вектор

Проверен тремя независимыми реализациями (hashlib, `openssl kdf`, низкоуровневый AES-GCM из `cryptography`):

| | |
|---|---|
| password | `termuxx-test` |
| salt | `000102030405060708090a0b0c0d0e0f` |
| nonce | `000102030405060708090a0b` |
| iterations | `200000` |
| plaintext | `{"passwords":{"00000000-0000-0000-0000-000000000001":"hunter2"}}` |
| key (hex) | `2129619e41dd3db751840f201078659167570c36cd46d61729ac77c989895c82` |
| data (base64) | `765Deq+mkx96CmNtWWzFo65I3QZFid4b+U+8wuuxysdBLEHj1artwfwkmWtUtcboB5PsYPBWTaOzFIbaNyCK4cziOYU2q9wNTACUgE2mHJM=` |

`python3 scripts/backup_tool.py test-vector` печатает его заново, `selftest` сверяет.

## Импорт: правила слияния

- Записи (`hosts`, `keys`, `snippets`) с тем же `id` **заменяются**, новые **добавляются**, ничего не удаляется.
- Секреты пишутся только если в бэкапе есть значение (пустые не стирают существующие).
- Если секреты зашифрованы, а пароль не введён — импортируются только метаданные («без паролей и ключей»).
- Неверный пароль → ошибка до каких-либо изменений.
- Битые элементы массивов пропускаются, остальные импортируются. Сервер без `id`/`hostname`,
  сниппет без `command` и проброс с портом вне 1…65535 пропускаются.
- `lastConnected` при обновлении берётся более поздний из двух.
- Ссылки (`keyID`, `jumpHostID`, `startupSnippetID`) сохраняются как есть.

## Совместимость с Linux

- Linux пишет `"app": "linux"` и те же поля. Свои дополнительные поля можно добавлять — iOS их игнорирует.
- Linux может хранить ключи файлами (`~/.local/share/termuxx/keys/<id>`), но в бэкап кладёт сам PEM-текст.
- `knownHosts` на Linux можно не использовать (системный `~/.ssh/known_hosts`), но при экспорте полезно
  заполнять его в том же формате, чтобы iPhone не спрашивал отпечаток заново.
