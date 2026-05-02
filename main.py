"""FastAPI + SQLite server for the DeepSeek streaming chat bot.

Run:
    python main.py

The browser app uses SQLite as the single source of truth and synchronizes UI
state through the WebSocket endpoint at /ws. DeepSeek requests can still be sent
through the same-origin streaming proxy at /proxy/deepseek.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.middleware.base import BaseHTTPMiddleware

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"

_default_data_dir = Path("/opt/chat-bot/data") if ROOT == Path("/opt/chat-bot") else ROOT / "data"
DATA_ROOT = Path(os.environ.get("CHATBOT_DATA_DIR", _default_data_dir)).resolve()
STATE_FILE = Path(os.environ.get("CHATBOT_STATE_FILE", DATA_ROOT / "app-state.json")).resolve()
DB_FILE = Path(os.environ.get("CHATBOT_SQLITE_FILE", DATA_ROOT / "chat-bot.sqlite3")).resolve()
DEFAULT_HOST = os.environ.get("HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PORT", "12322"))
SERVER_API_KEY = (os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("CHATBOT_API_KEY") or "").strip()
MAX_PROXY_BODY_BYTES = int(os.environ.get("CHATBOT_MAX_PROXY_BODY_BYTES", str(10 * 1024 * 1024)))

RESOURCE_KINDS = (
    "jailbreakPreset",
    "characterCard",
    "worldBook",
    "regexScript",
    "reasoningTemplate",
)

GLOBAL_SETTING_PATHS: dict[str, tuple[str, ...]] = {
    "api.apiKey": ("apiKey",),
    "api.baseUrl": ("baseUrl",),
    "api.betaBaseUrl": ("betaBaseUrl",),
    "api.useProxy": ("useProxy",),
    "model.name": ("model",),
    "model.temperature": ("temperature",),
    "model.topP": ("topP",),
    "model.maxTokens": ("maxTokens",),
    "model.responseLength": ("responseLength",),
    "model.customLength": ("customLength",),
    "model.presencePenalty": ("presencePenalty",),
    "model.frequencyPenalty": ("frequencyPenalty",),
    "model.stop": ("stop",),
    "thinking.enabled": ("thinking",),
    "thinking.reasoningEffort": ("reasoningEffort",),
    "output.jsonMode": ("jsonMode",),
    "output.prefixEnabled": ("prefixEnabled",),
    "output.assistantPrefix": ("assistantPrefix",),
    "tools.enabled": ("toolsEnabled",),
    "tools.json": ("toolsJson",),
    "formatting.chatDisplayMode": ("formatting", "chatDisplayMode"),
    "formatting.showTags": ("formatting", "showTagsInResponses"),
    "formatting.autoFixMarkdown": ("formatting", "autoFixMarkdown"),
    "formatting.showReasoningBlocks": ("formatting", "showReasoningBlocks"),
    "formatting.allowScopedRegex": ("formatting", "allowScopedRegex"),
    "ui.theme": ("theme",),
    "ui.fontScale": ("fontScale",),
    "ui.timestamps": ("showTimestamps",),
    "ui.lineNumbers": ("lineNumbers",),
    "characterBookDecisions": ("characterBookDecisions",),
}

SESSION_SETTING_PATHS: dict[str, tuple[str, ...]] = {
    "systemPrompt": ("systemPrompt",),
    "jailbreak.enabled": ("jailbreakEnabled",),
    "jailbreak.prompt": ("jailbreakPrompt",),
    "jailbreak.source": ("jailbreakSource",),
    "jailbreak.importMeta": ("jailbreakImportMeta",),
    "jailbreak.importKind": ("jailbreakImportKind",),
    "jailbreak.parsed": ("jailbreakParsed",),
    "jailbreak.messages": ("jailbreakMessages",),
    "jailbreak.layout": ("jailbreakLayout",),
    "jailbreak.settings": ("jailbreakSettings",),
    "jailbreak.presetId": ("jailbreakPresetId",),
    "jailbreak.postHistoryInstructions": ("jailbreakPostHistoryInstructions",),
    "persona.userName": ("userName",),
    "persona.userPersona": ("userPersona",),
    "rp.enabled": ("rpMode",),
    "rp.perspective": ("rpPerspective",),
    "rp.suggestions": ("rpSuggestions",),
    "rp.memory": ("rpMemory",),
    "background.enabled": ("backgroundEnabled",),
    "background.text": ("background",),
    "character.enabled": ("characterCardEnabled",),
    "character.cardId": ("characterCardId",),
    "character.card": ("characterCard",),
    "character.greetingIndex": ("greetingIndex",),
    "character.bookHandling": ("characterBookHandling",),
    "worldBook.enabled": ("worldBookEnabled",),
    "worldBook.book": ("worldBook",),
    "worldBook.scanDepth": ("worldBookScanDepth",),
    "worldBook.maxEntries": ("worldBookMaxEntries",),
    "worldBook.tokenBudget": ("worldBookTokenBudget",),
    "worldBook.recursive": ("worldBookRecursive",),
    "worldBook.activeIds": ("activeWorldBookIds",),
    "session.stats": ("stats",),
}


class CacheHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        if request.url.path.startswith(("/api/", "/ws")) or request.url.path == "/health":
            response.headers.setdefault("Cache-Control", "no-store")
        return response


def current_iso_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(raw: str | bytes | None, default: Any = None) -> Any:
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def infer_value_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if value is None:
        return "null"
    return type(value).__name__


def deep_get(obj: dict[str, Any], path: Iterable[str], default: Any = None) -> Any:
    cur: Any = obj
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def has_path(obj: dict[str, Any], path: Iterable[str]) -> bool:
    cur: Any = obj
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return False
        cur = cur[key]
    return True


def normalize_bool(value: Any) -> int:
    return 1 if bool(value) else 0


def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS global_settings (
          key TEXT PRIMARY KEY,
          value_type TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_settings (
          conversation_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value_type TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (conversation_id, key),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          reasoning_content TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
          UNIQUE (conversation_id, position)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conversation_position
        ON messages(conversation_id, position);

        CREATE TABLE IF NOT EXISTS resources (
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (kind, id)
        );

        CREATE INDEX IF NOT EXISTS idx_resources_kind_updated
        ON resources(kind, updated_at);
        """
    )
    # Lightweight forward-compatible migration for databases created before the
    # optional conversation ordering column existed.
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(conversations)")}
    if "position" not in columns:
        conn.execute("ALTER TABLE conversations ADD COLUMN position INTEGER NOT NULL DEFAULT 0")


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: Any) -> None:
    now = current_iso_timestamp()
    conn.execute(
        """
        INSERT INTO app_meta(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, str(value), now),
    )


def get_revision(conn: sqlite3.Connection) -> int:
    try:
        return int(get_meta(conn, "data_revision", "0") or 0)
    except ValueError:
        return 0


def bump_revision(conn: sqlite3.Connection) -> int:
    revision = get_revision(conn) + 1
    set_meta(conn, "data_revision", revision)
    return revision


def upsert_global_setting(conn: sqlite3.Connection, key: str, value: Any, value_type: str | None = None) -> None:
    if SERVER_API_KEY and key in {"api.apiKey", "apiKey"}:
        conn.execute("DELETE FROM global_settings WHERE key IN ('api.apiKey', 'apiKey')")
        return
    now = current_iso_timestamp()
    conn.execute(
        """
        INSERT INTO global_settings(key, value_type, value_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_type = excluded.value_type,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
        """,
        (key, value_type or infer_value_type(value), json_dumps(value), now),
    )


def upsert_conversation_setting(
    conn: sqlite3.Connection,
    conversation_id: str,
    key: str,
    value: Any,
    value_type: str | None = None,
) -> None:
    ensure_conversation_exists(conn, conversation_id)
    now = current_iso_timestamp()
    conn.execute(
        """
        INSERT INTO conversation_settings(conversation_id, key, value_type, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, key) DO UPDATE SET
          value_type = excluded.value_type,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
        """,
        (conversation_id, key, value_type or infer_value_type(value), json_dumps(value), now),
    )


def ensure_conversation_exists(conn: sqlite3.Connection, conversation_id: str) -> None:
    row = conn.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
    if not row:
        raise ValueError(f"Conversation does not exist: {conversation_id}")


def normalize_message_payload(message: dict[str, Any]) -> dict[str, Any]:
    now = current_iso_timestamp()
    payload = dict(message or {})
    payload.setdefault("id", f"msg_{int(datetime.now().timestamp() * 1000)}")
    payload.setdefault("role", "user")
    payload.setdefault("content", "")
    payload.setdefault("reasoning_content", payload.get("reasoningContent", "") or "")
    payload.setdefault("createdAt", now)
    payload.setdefault("updatedAt", payload.get("createdAt") or now)
    return payload


def insert_message(conn: sqlite3.Connection, conversation_id: str, message: dict[str, Any], position: int | None = None) -> None:
    ensure_conversation_exists(conn, conversation_id)
    payload = normalize_message_payload(message)
    if position is None:
        row = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM messages WHERE conversation_id = ?", (conversation_id,)).fetchone()
        position = int(row["next_pos"] if row else 0)
    now = current_iso_timestamp()
    payload.setdefault("updatedAt", now)
    conn.execute(
        """
        INSERT INTO messages(id, conversation_id, position, role, content, reasoning_content, created_at, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          position = excluded.position,
          role = excluded.role,
          content = excluded.content,
          reasoning_content = excluded.reasoning_content,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
        """,
        (
            str(payload["id"]),
            conversation_id,
            int(position),
            str(payload.get("role") or "user"),
            str(payload.get("content") or ""),
            str(payload.get("reasoning_content") or ""),
            str(payload.get("createdAt") or now),
            str(payload.get("updatedAt") or now),
            json_dumps(payload),
        ),
    )


def touch_conversation(conn: sqlite3.Connection, conversation_id: str, updated_at: str | None = None) -> None:
    conn.execute(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        (updated_at or current_iso_timestamp(), conversation_id),
    )


def import_state_snapshot(conn: sqlite3.Connection, snapshot: dict[str, Any]) -> None:
    """Replace all user data with a legacy app-state shaped snapshot."""
    data = snapshot.get("data") if isinstance(snapshot, dict) and "data" in snapshot else snapshot
    if not isinstance(data, dict):
        raise ValueError("Backup data must be a JSON object")

    conn.execute("DELETE FROM messages")
    conn.execute("DELETE FROM conversation_settings")
    conn.execute("DELETE FROM conversations")
    conn.execute("DELETE FROM resources")
    conn.execute("DELETE FROM global_settings")

    settings = data.get("settings") if isinstance(data.get("settings"), dict) else {}
    for key, path in GLOBAL_SETTING_PATHS.items():
        # characterBookDecisions historically lived at the root rather than in settings.
        source = data if key == "characterBookDecisions" else settings
        if has_path(source, path):
            upsert_global_setting(conn, key, deep_get(source, path))
    if data.get("activeSessionId"):
        upsert_global_setting(conn, "activeSessionId", data.get("activeSessionId"), "string")
    if SERVER_API_KEY:
        upsert_global_setting(conn, "api.useProxy", True, "boolean")
        conn.execute("DELETE FROM global_settings WHERE key = 'api.apiKey'")

    formatting = settings.get("formatting") if isinstance(settings.get("formatting"), dict) else {}
    resource_sources = [
        ("jailbreakPreset", data.get("jailbreakPresets")),
        ("characterCard", data.get("characterCards")),
        ("worldBook", data.get("worldBooks")),
        ("regexScript", formatting.get("regexScripts")),
        ("reasoningTemplate", formatting.get("reasoningTemplates")),
    ]
    for kind, items in resource_sources:
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            resource_id = str(item.get("id") or f"{kind}_{index}")
            name = str(item.get("name") or item.get("title") or item.get("displayName") or "")
            updated_at = str(item.get("updated_at") or item.get("updatedAt") or item.get("created_at") or item.get("createdAt") or current_iso_timestamp())
            payload = dict(item)
            payload.setdefault("id", resource_id)
            payload.setdefault("name", name)
            conn.execute(
                """
                INSERT INTO resources(kind, id, name, updated_at, payload_json)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(kind, id) DO UPDATE SET
                  name = excluded.name,
                  updated_at = excluded.updated_at,
                  payload_json = excluded.payload_json
                """,
                (kind, resource_id, name, updated_at, json_dumps(payload)),
            )

    sessions = data.get("sessions") if isinstance(data.get("sessions"), list) else []
    for position, session in enumerate(sessions):
        if not isinstance(session, dict):
            continue
        now = current_iso_timestamp()
        conversation_id = str(session.get("id") or f"session_{position}")
        created_at = str(session.get("createdAt") or session.get("created_at") or now)
        updated_at = str(session.get("updatedAt") or session.get("updated_at") or created_at)
        conn.execute(
            """
            INSERT INTO conversations(id, title, pinned, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                conversation_id,
                str(session.get("title") or "新会话"),
                normalize_bool(session.get("pinned")),
                position,
                created_at,
                updated_at,
            ),
        )
        for key, path in SESSION_SETTING_PATHS.items():
            if has_path(session, path):
                upsert_conversation_setting(conn, conversation_id, key, deep_get(session, path))
        messages = session.get("messages") if isinstance(session.get("messages"), list) else []
        for msg_position, message in enumerate(messages):
            if isinstance(message, dict):
                insert_message(conn, conversation_id, message, msg_position)


def initialize_database() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = connect_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        ensure_schema(conn)
        schema_version = get_meta(conn, "schema_version")
        if not schema_version:
            if STATE_FILE.exists():
                try:
                    with STATE_FILE.open("r", encoding="utf-8") as file:
                        payload = json.load(file)
                    import_state_snapshot(conn, payload)
                    set_meta(conn, "migration_source", str(STATE_FILE))
                    set_meta(conn, "migration_completed_at", current_iso_timestamp())
                    # Preserve the legacy revision as provenance, but SQLite starts
                    # with a fresh monotonic write revision.
                    if isinstance(payload, dict) and payload.get("revision") is not None:
                        set_meta(conn, "migration_legacy_revision", payload.get("revision"))
                except Exception as exc:
                    raise RuntimeError(f"Failed to migrate legacy state file {STATE_FILE}: {exc}") from exc
            set_meta(conn, "schema_version", 1)
            if get_meta(conn, "data_revision") is None:
                set_meta(conn, "data_revision", 1 if STATE_FILE.exists() else 0)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def rows_to_settings(rows: Iterable[sqlite3.Row], *, apply_server_api_mode: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for row in rows:
        result[str(row["key"])] = json_loads(row["value_json"], None)
    if apply_server_api_mode and SERVER_API_KEY:
        result.pop("api.apiKey", None)
        result["api.useProxy"] = True
    return result


def get_bootstrap_payload() -> dict[str, Any]:
    conn = connect_db()
    try:
        revision = get_revision(conn)
        settings = rows_to_settings(conn.execute("SELECT key, value_json FROM global_settings ORDER BY key"), apply_server_api_mode=True)
        conversations = []
        for row in conn.execute(
            """
            SELECT c.id, c.title, c.pinned, c.position, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.position ASC, c.updated_at DESC
            """
        ):
            conversations.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "pinned": bool(row["pinned"]),
                    "position": int(row["position"] or 0),
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                    "messageCount": int(row["message_count"] or 0),
                }
            )
        resources = {kind: [] for kind in RESOURCE_KINDS}
        for row in conn.execute("SELECT kind, id, name, updated_at, payload_json FROM resources ORDER BY kind, updated_at DESC"):
            payload = json_loads(row["payload_json"], {})
            if not isinstance(payload, dict):
                payload = {}
            payload.setdefault("id", row["id"])
            payload.setdefault("name", row["name"])
            payload.setdefault("updated_at", row["updated_at"])
            resources.setdefault(row["kind"], []).append(payload)
        active_id = settings.get("activeSessionId") or (conversations[0]["id"] if conversations else None)
        return {
            "type": "bootstrap",
            "revision": revision,
            "settings": settings,
            "conversations": conversations,
            "activeSessionId": active_id,
            "resources": resources,
        }
    finally:
        conn.close()


def get_conversation_snapshot(conversation_id: str, request_id: str | None = None) -> dict[str, Any]:
    conn = connect_db()
    try:
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if not row:
            raise ValueError(f"Conversation does not exist: {conversation_id}")
        settings = rows_to_settings(
            conn.execute(
                "SELECT key, value_json FROM conversation_settings WHERE conversation_id = ? ORDER BY key",
                (conversation_id,),
            )
        )
        messages = []
        for msg_row in conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY position ASC",
            (conversation_id,),
        ):
            payload = json_loads(msg_row["payload_json"], {})
            if not isinstance(payload, dict):
                payload = {}
            payload.setdefault("id", msg_row["id"])
            payload.setdefault("role", msg_row["role"])
            payload.setdefault("content", msg_row["content"])
            payload.setdefault("reasoning_content", msg_row["reasoning_content"])
            payload.setdefault("createdAt", msg_row["created_at"])
            payload.setdefault("updatedAt", msg_row["updated_at"])
            messages.append(payload)
        return {
            "type": "conversation.snapshot",
            "requestId": request_id,
            "revision": get_revision(conn),
            "conversation": {
                "id": row["id"],
                "title": row["title"],
                "pinned": bool(row["pinned"]),
                "position": int(row["position"] or 0),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
                "settings": settings,
                "messages": messages,
            },
        }
    finally:
        conn.close()


def replace_messages_for_conversation(conn: sqlite3.Connection, conversation_id: str, messages: list[Any]) -> None:
    ensure_conversation_exists(conn, conversation_id)
    conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
    for position, message in enumerate(messages):
        if isinstance(message, dict):
            insert_message(conn, conversation_id, message, position)
    touch_conversation(conn, conversation_id)


def upsert_resource(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    kind = str(payload.get("kind") or "")
    resource_id = str(payload.get("id") or "")
    if not kind or not resource_id:
        raise ValueError("Resource kind and id are required")
    resource_payload = payload.get("payload")
    if not isinstance(resource_payload, dict):
        resource_payload = {k: v for k, v in payload.items() if k not in {"kind", "payload"}}
    resource_payload.setdefault("id", resource_id)
    name = str(payload.get("name") or resource_payload.get("name") or resource_payload.get("title") or "")
    updated_at = str(resource_payload.get("updated_at") or resource_payload.get("updatedAt") or payload.get("updatedAt") or current_iso_timestamp())
    conn.execute(
        """
        INSERT INTO resources(kind, id, name, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(kind, id) DO UPDATE SET
          name = excluded.name,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
        """,
        (kind, resource_id, name, updated_at, json_dumps(resource_payload)),
    )


def apply_write_op(conn: sqlite3.Connection, op: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = {}

    if op == "setting.set":
        key = str(payload.get("key") or "")
        if not key:
            raise ValueError("Setting key is required")
        upsert_global_setting(conn, key, payload.get("value"), payload.get("valueType") or payload.get("value_type"))

    elif op == "setting.delete":
        key = str(payload.get("key") or "")
        if not key:
            raise ValueError("Setting key is required")
        conn.execute("DELETE FROM global_settings WHERE key = ?", (key,))

    elif op == "settings.batchSet":
        items = payload.get("items")
        if isinstance(items, dict):
            items = [{"key": key, "value": value} for key, value in items.items()]
        if not isinstance(items, list):
            settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
            items = [{"key": key, "value": value} for key, value in settings.items()]
        for item in items:
            if isinstance(item, dict) and item.get("key"):
                upsert_global_setting(conn, str(item["key"]), item.get("value"), item.get("valueType") or item.get("value_type"))
        for key in payload.get("deleteKeys") or payload.get("deletes") or []:
            conn.execute("DELETE FROM global_settings WHERE key = ?", (str(key),))

    elif op == "conversation.create":
        conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else payload
        conversation_id = str(conversation.get("id") or "")
        if not conversation_id:
            raise ValueError("Conversation id is required")
        now = current_iso_timestamp()
        conn.execute(
            """
            INSERT INTO conversations(id, title, pinned, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              pinned = excluded.pinned,
              position = excluded.position,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at
            """,
            (
                conversation_id,
                str(conversation.get("title") or "新会话"),
                normalize_bool(conversation.get("pinned")),
                int(conversation.get("position") or payload.get("position") or 0),
                str(conversation.get("createdAt") or now),
                str(conversation.get("updatedAt") or now),
            ),
        )
        settings = conversation.get("settings") if isinstance(conversation.get("settings"), dict) else payload.get("settings")
        if isinstance(settings, dict):
            for key, value in settings.items():
                upsert_conversation_setting(conn, conversation_id, str(key), value)
        messages = conversation.get("messages") if isinstance(conversation.get("messages"), list) else payload.get("messages")
        if isinstance(messages, list) and messages:
            replace_messages_for_conversation(conn, conversation_id, messages)

    elif op == "conversation.update":
        conversation_id = str(payload.get("conversationId") or payload.get("id") or "")
        if not conversation_id:
            raise ValueError("Conversation id is required")
        ensure_conversation_exists(conn, conversation_id)
        patch = payload.get("patch") if isinstance(payload.get("patch"), dict) else payload
        allowed = {
            "title": "title",
            "pinned": "pinned",
            "position": "position",
            "createdAt": "created_at",
            "updatedAt": "updated_at",
        }
        updates: list[str] = []
        values: list[Any] = []
        for source_key, column in allowed.items():
            if source_key in patch:
                updates.append(f"{column} = ?")
                values.append(normalize_bool(patch[source_key]) if source_key == "pinned" else patch[source_key])
        if not updates:
            touch_conversation(conn, conversation_id)
        else:
            values.append(conversation_id)
            conn.execute(f"UPDATE conversations SET {', '.join(updates)} WHERE id = ?", values)

    elif op == "conversation.delete":
        conversation_id = str(payload.get("conversationId") or payload.get("id") or "")
        if not conversation_id:
            raise ValueError("Conversation id is required")
        conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))

    elif op == "conversation.reorder":
        order = payload.get("order") or payload.get("ids") or []
        if not isinstance(order, list):
            raise ValueError("Conversation reorder requires an order array")
        for position, conversation_id in enumerate(order):
            conn.execute("UPDATE conversations SET position = ? WHERE id = ?", (position, str(conversation_id)))

    elif op == "conversationSetting.set":
        upsert_conversation_setting(
            conn,
            str(payload.get("conversationId") or ""),
            str(payload.get("key") or ""),
            payload.get("value"),
            payload.get("valueType") or payload.get("value_type"),
        )

    elif op == "conversationSetting.delete":
        conversation_id = str(payload.get("conversationId") or "")
        key = str(payload.get("key") or "")
        if not conversation_id or not key:
            raise ValueError("Conversation id and key are required")
        ensure_conversation_exists(conn, conversation_id)
        conn.execute("DELETE FROM conversation_settings WHERE conversation_id = ? AND key = ?", (conversation_id, key))

    elif op == "conversationSettings.batchSet":
        conversation_id = str(payload.get("conversationId") or "")
        if not conversation_id:
            raise ValueError("Conversation id is required")
        ensure_conversation_exists(conn, conversation_id)
        items = payload.get("items")
        if isinstance(items, dict):
            items = [{"key": key, "value": value} for key, value in items.items()]
        if not isinstance(items, list):
            settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
            items = [{"key": key, "value": value} for key, value in settings.items()]
        for item in items:
            if isinstance(item, dict) and item.get("key"):
                upsert_conversation_setting(conn, conversation_id, str(item["key"]), item.get("value"), item.get("valueType") or item.get("value_type"))
        for key in payload.get("deleteKeys") or payload.get("deletes") or []:
            conn.execute("DELETE FROM conversation_settings WHERE conversation_id = ? AND key = ?", (conversation_id, str(key)))

    elif op == "message.append":
        conversation_id = str(payload.get("conversationId") or "")
        message = payload.get("message")
        if not conversation_id or not isinstance(message, dict):
            raise ValueError("Conversation id and message are required")
        insert_message(conn, conversation_id, message, payload.get("position"))
        touch_conversation(conn, conversation_id, message.get("updatedAt") or message.get("createdAt"))

    elif op == "message.update":
        conversation_id = str(payload.get("conversationId") or "")
        message_id = str(payload.get("messageId") or payload.get("id") or "")
        patch = payload.get("patch") if isinstance(payload.get("patch"), dict) else {}
        if not conversation_id or not message_id:
            raise ValueError("Conversation id and message id are required")
        row = conn.execute("SELECT * FROM messages WHERE id = ? AND conversation_id = ?", (message_id, conversation_id)).fetchone()
        if not row:
            raise ValueError(f"Message does not exist: {message_id}")
        existing = json_loads(row["payload_json"], {})
        if not isinstance(existing, dict):
            existing = {}
        payload_json = patch.get("payload") if isinstance(patch.get("payload"), dict) else None
        merged = {**existing, **patch}
        if payload_json:
            merged = {**merged, **payload_json}
        merged.pop("payload", None)
        merged["id"] = message_id
        merged.setdefault("role", row["role"])
        merged.setdefault("createdAt", row["created_at"])
        merged["updatedAt"] = patch.get("updatedAt") or current_iso_timestamp()
        conn.execute(
            """
            UPDATE messages
            SET role = ?, content = ?, reasoning_content = ?, updated_at = ?, payload_json = ?
            WHERE id = ? AND conversation_id = ?
            """,
            (
                str(merged.get("role") or row["role"]),
                str(merged.get("content") or ""),
                str(merged.get("reasoning_content") or ""),
                str(merged.get("updatedAt")),
                json_dumps(merged),
                message_id,
                conversation_id,
            ),
        )
        touch_conversation(conn, conversation_id)

    elif op == "message.delete":
        conversation_id = str(payload.get("conversationId") or "")
        message_id = str(payload.get("messageId") or payload.get("id") or "")
        if not conversation_id or not message_id:
            raise ValueError("Conversation id and message id are required")
        conn.execute("DELETE FROM messages WHERE id = ? AND conversation_id = ?", (message_id, conversation_id))
        rows = conn.execute("SELECT id FROM messages WHERE conversation_id = ? ORDER BY position ASC", (conversation_id,)).fetchall()
        for position, row in enumerate(rows):
            conn.execute("UPDATE messages SET position = ? WHERE id = ?", (position, row["id"]))
        touch_conversation(conn, conversation_id)

    elif op == "messages.replaceForConversation":
        conversation_id = str(payload.get("conversationId") or "")
        messages = payload.get("messages")
        if not conversation_id or not isinstance(messages, list):
            raise ValueError("Conversation id and messages array are required")
        replace_messages_for_conversation(conn, conversation_id, messages)

    elif op == "messages.clearForConversation":
        conversation_id = str(payload.get("conversationId") or "")
        if not conversation_id:
            raise ValueError("Conversation id is required")
        ensure_conversation_exists(conn, conversation_id)
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
        touch_conversation(conn, conversation_id)

    elif op == "resource.upsert":
        upsert_resource(conn, payload)

    elif op == "resource.delete":
        kind = str(payload.get("kind") or "")
        resource_id = str(payload.get("id") or "")
        if not kind or not resource_id:
            raise ValueError("Resource kind and id are required")
        conn.execute("DELETE FROM resources WHERE kind = ? AND id = ?", (kind, resource_id))

    elif op == "resources.replaceKind":
        kind = str(payload.get("kind") or "")
        resources = payload.get("resources")
        if not kind or not isinstance(resources, list):
            raise ValueError("Resource kind and resources array are required")
        conn.execute("DELETE FROM resources WHERE kind = ?", (kind,))
        for resource in resources:
            if isinstance(resource, dict):
                upsert_resource(conn, {"kind": kind, "id": resource.get("id"), "name": resource.get("name"), "payload": resource})

    elif op == "backup.replaceAll":
        state = payload.get("state") or payload.get("data") or payload.get("backup") or payload
        if not isinstance(state, dict):
            raise ValueError("Backup state must be an object")
        import_state_snapshot(conn, state)

    else:
        raise ValueError(f"Unsupported op: {op}")

    return payload


write_lock = asyncio.Lock()


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def broadcast(self, message: dict[str, Any], *, exclude: WebSocket | None = None) -> None:
        stale: list[WebSocket] = []
        for websocket in list(self.connections):
            if websocket is exclude:
                continue
            try:
                await websocket.send_json(message)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(websocket)


manager = ConnectionManager()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_database()
    print(f"DeepSeek Chat Bot is listening on {DEFAULT_HOST}:{DEFAULT_PORT}")
    print(f"SQLite data source: {DB_FILE}")
    print(f"Static web root: {WEB_ROOT}")
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(CacheHeadersMiddleware)


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/config")
async def api_config() -> dict[str, Any]:
    return {
        "serverApiKeyConfigured": bool(SERVER_API_KEY),
        "dataBackend": "sqlite-websocket",
        "sqliteFile": str(DB_FILE),
    }


@app.options("/proxy/deepseek")
async def proxy_deepseek_options() -> Response:
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Headers": "content-type, x-api-key, x-target-url",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
    )


@app.post("/proxy/deepseek")
async def proxy_deepseek(request: Request):
    body = await request.body()
    if len(body) > MAX_PROXY_BODY_BYTES:
        raise HTTPException(status_code=413, detail=f"Proxy payload is too large. Limit: {MAX_PROXY_BODY_BYTES} bytes")

    api_key = (request.headers.get("x-api-key") or SERVER_API_KEY or "").strip()
    target_url = (request.headers.get("x-target-url") or "").strip()
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing x-api-key header")
    if not target_url:
        raise HTTPException(status_code=400, detail="Missing x-target-url header")
    parsed = urlparse(target_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Only https target URLs are allowed")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json",
        "User-Agent": "DeepSeekChatBot/2.0",
    }
    client = httpx.AsyncClient(timeout=httpx.Timeout(connect=15.0, read=None, write=60.0, pool=15.0))
    try:
        upstream_request = client.build_request("POST", target_url, content=body, headers=headers)
        upstream_response = await client.send(upstream_request, stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Proxy error: {exc}") from exc

    response_headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    content_type = upstream_response.headers.get("content-type")
    if content_type:
        response_headers["Content-Type"] = content_type

    async def close_upstream() -> None:
        await upstream_response.aclose()
        await client.aclose()

    return StreamingResponse(
        upstream_response.aiter_bytes(),
        status_code=upstream_response.status_code,
        headers=response_headers,
        background=BackgroundTask(close_upstream),
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        await websocket.send_json(get_bootstrap_payload())
        while True:
            message = await websocket.receive_json()
            msg_type = message.get("type")
            request_id = message.get("requestId")
            if msg_type == "conversation.load":
                try:
                    snapshot = get_conversation_snapshot(str(message.get("conversationId") or ""), request_id)
                    await websocket.send_json(snapshot)
                except Exception as exc:
                    await websocket.send_json({"type": "error", "requestId": request_id, "error": str(exc), "reload": True})
                continue

            if msg_type != "op":
                await websocket.send_json({"type": "error", "requestId": request_id, "error": f"Unsupported message type: {msg_type}"})
                continue

            op = str(message.get("op") or "")
            payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
            try:
                async with write_lock:
                    conn = connect_db()
                    try:
                        conn.execute("BEGIN IMMEDIATE")
                        normalized_payload = apply_write_op(conn, op, payload)
                        revision = bump_revision(conn)
                        conn.commit()
                    except Exception:
                        conn.rollback()
                        raise
                    finally:
                        conn.close()
                await websocket.send_json({"type": "ack", "requestId": request_id, "revision": revision})
                await manager.broadcast(
                    {"type": "event", "revision": revision, "op": op, "payload": normalized_payload},
                    exclude=websocket,
                )
            except Exception as exc:
                await websocket.send_json({"type": "error", "requestId": request_id, "error": str(exc), "reload": True})
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
        raise


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", "no-store")
        return response


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html", media_type="text/html")


# Add a couple of MIME types commonly needed by direct ES module loading.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
app.mount("/", NoCacheStaticFiles(directory=WEB_ROOT, html=True), name="web")


def main() -> None:
    uvicorn.run("main:app", host=DEFAULT_HOST, port=DEFAULT_PORT, reload=False, log_level="info")


if __name__ == "__main__":
    main()
