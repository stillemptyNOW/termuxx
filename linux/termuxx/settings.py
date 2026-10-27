"""Настройки приложения (~/.config/termuxx/settings.json)."""

from __future__ import annotations

import json
import os
from typing import Callable

from termuxx.store import CONFIG_DIR

SETTINGS_PATH = os.path.join(CONFIG_DIR, "settings.json")

DEFAULTS = {
    "themeID": "termuxx",
    "font": "JetBrains Mono 11",
    "scrollback": 10000,
    "cursorShape": "block",  # block | ibeam | underline
    "cursorBlink": True,
    "audibleBell": False,
    "colorScheme": "dark",  # dark | light | system
    "confirmClose": True,
    "openLocalOnStart": True,
    "copyOnSelect": False,
    "fontScale": 1.0,
}


class Settings:
    _instance = None

    @classmethod
    def get(cls) -> "Settings":
        if cls._instance is None:
            cls._instance = Settings()
        return cls._instance

    def __init__(self, path: str = SETTINGS_PATH):
        self.path = path
        self._data = dict(DEFAULTS)
        self._listeners: list[Callable[[str], None]] = []
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                for k, v in data.items():
                    if k in DEFAULTS and type(v) is type(DEFAULTS[k]) or (k in DEFAULTS and isinstance(DEFAULTS[k], float) and isinstance(v, (int, float))):
                        self._data[k] = v
        except (OSError, ValueError):
            pass

    def __getitem__(self, key: str):
        return self._data.get(key, DEFAULTS.get(key))

    def set(self, key: str, value) -> None:
        if self._data.get(key) == value:
            return
        self._data[key] = value
        try:
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        except OSError as e:
            print("termuxx: cannot save settings:", e)
        for cb in list(self._listeners):
            try:
                cb(key)
            except Exception as e:
                print("termuxx: settings listener error:", e)

    def subscribe(self, callback: Callable[[str], None]) -> None:
        self._listeners.append(callback)

    def unsubscribe(self, callback: Callable[[str], None]) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)
