#!/usr/bin/env python3
"""Invio una tantum del benvenuto VelvetHub 18+.

Default: dry-run (stampa i conteggi, non invia nulla).
Con --send invia il messaggio una volta per chat_id privato, rispetta i
limiti di Telegram, salta i 403 e marca welcomed così non parte due volte.

Il token si legge dalla stessa configurazione di ourvelvet e non viene mai stampato.
Non eseguire questo script da applica-welcome.sh.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

PLACEHOLDER_TOKEN = "INSERISCI_IL_TUO_BOT_TOKEN"
APPDIR = os.environ.get("VH_APPDIR", "/opt/ourvelvet")
DATA_DIR = Path(os.environ.get("VH_DATA_DIR", os.path.join(APPDIR, "data")))
DB_PATH = Path(os.environ.get("VH_BOT_USERS_DB", str(DATA_DIR / "bot_users.db")))
LOG_PATH = os.environ.get("VH_BROADCAST_LOG", "/var/log/velvet-broadcast.log")
SLEEP_BETWEEN = float(os.environ.get("VH_BROADCAST_SLEEP", "0.08"))

# Colonne che possono contenere un chat_id Telegram. Non si usano id/user_id
# generici (potrebbero essere autoincrement o handle interni, non chat Telegram).
CHAT_ID_COLS = frozenset(
    {
        "chat_id",
        "telegram_id",
        "telegram_chat_id",
        "tg_chat_id",
        "tg_id",
        "telegram_user_id",
        "tg_user_id",
    }
)

MSG_WELCOME = (
    "🖤 Welcome to VelvetHub 18+\n"
    "\n"
    "You're in. This is an adults-only space built on consent.\n"
    "\n"
    "• Chat now with Rubina, the Mistress of the room\n"
    "• Join the Radar: Mistress or Slave, your choice\n"
    "• Visit the app: velvet.x-zdos.it/app\n"
    "• Community: t.me/OurVelvetHub\n"
    "\n"
    "Rules: 18+ only · consent always · safeword ROSSO stops everything.\n"
    "VELVET is a community token, no yield, no financial promises."
)

APP_URL = "https://velvet.x-zdos.it/app"
SITE_URL = "https://velvet.x-zdos.it"
CHANNEL_URL = "https://t.me/OurVelvetHub"


def _setup_log() -> logging.Logger:
    log = logging.getLogger("velvet.broadcast")
    log.setLevel(logging.INFO)
    log.handlers.clear()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(sh)
    try:
        parent = os.path.dirname(LOG_PATH)
        if parent:
            os.makedirs(parent, exist_ok=True)
        fh = logging.FileHandler(LOG_PATH)
        fh.setFormatter(fmt)
        log.addHandler(fh)
    except OSError as exc:
        log.warning("impossibile scrivere il log in %s: %s", LOG_PATH, exc)
    return log


log = _setup_log()


def _looks_like_token(value: str) -> bool:
    # Formato Telegram: 123456789:AA... — non si stampa mai il valore.
    return bool(value) and ":" in value and len(value) >= 30 and value != PLACEHOLDER_TOKEN


def _from_env_file(path: str) -> Optional[str]:
    keys = ("BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "VH_BOT_TOKEN")
    try:
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[7:].lstrip()
                key, _, val = line.partition("=")
                key = key.strip()
                if key not in keys:
                    continue
                val = val.strip().strip("'").strip('"')
                if _looks_like_token(val) or (val and val != PLACEHOLDER_TOKEN):
                    return val
    except OSError:
        return None
    return None


def _from_systemd() -> Optional[str]:
    """Legge Environment / EnvironmentFile del servizio, senza stamparli."""
    import subprocess

    try:
        out = subprocess.check_output(
            ["systemctl", "show", "ourvelvet", "-p", "Environment", "-p", "EnvironmentFiles", "--no-pager"],
            text=True,
            errors="replace",
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    token = None
    for line in out.splitlines():
        if line.startswith("EnvironmentFiles="):
            # Formato: /path/to/file (ignore_errors) ; /altro ...
            rest = line.split("=", 1)[1]
            for part in rest.split(";"):
                path = part.strip().split(" ", 1)[0].strip()
                if path:
                    token = _from_env_file(path) or token
        elif line.startswith("Environment="):
            # systemctl show non mette i valori tra virgolette in modo uniforme
            rest = line.split("=", 1)[1]
            for key in ("BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "VH_BOT_TOKEN"):
                # Cerca KEY=valore
                needle = key + "="
                idx = 0
                while True:
                    i = rest.find(needle, idx)
                    if i < 0:
                        break
                    start = i + len(needle)
                    # valore fino allo spazio successivo che precede un'altra KEY=
                    j = start
                    # I token Telegram non contengono spazi.
                    while j < len(rest) and not rest[j].isspace():
                        j += 1
                    val = rest[start:j].strip().strip('"').strip("'")
                    if val and val != PLACEHOLDER_TOKEN:
                        token = val
                    idx = j
    return token


def load_token() -> str:
    for key in ("BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "VH_BOT_TOKEN"):
        val = os.environ.get(key)
        if val and val != PLACEHOLDER_TOKEN:
            return val

    if APPDIR not in sys.path:
        sys.path.insert(0, APPDIR)
    try:
        from app.core.config import settings  # type: ignore

        val = getattr(settings, "BOT_TOKEN", None)
        if val and val != PLACEHOLDER_TOKEN:
            return str(val)
    except Exception:
        pass

    for path in (
        os.path.join(APPDIR, ".env"),
        os.path.join(APPDIR, ".env.local"),
        "/etc/ourvelvet.env",
        "/etc/ourvelvet/ourvelvet.env",
    ):
        val = _from_env_file(path)
        if val:
            return val

    val = _from_systemd()
    if val:
        return val

    raise SystemExit(
        "ERRORE: token del bot non trovato nella config/env di ourvelvet (il valore non viene mostrato)."
    )


def is_private_chat_id(value: object) -> bool:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return False
    # Chat private: id utente positivo. Gruppi e canali sono negativi.
    return n > 0


def ensure_users_db(path: Path = DB_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=10)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=5000")
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS bot_users (
                chat_id INTEGER PRIMARY KEY,
                first_seen INTEGER NOT NULL,
                welcomed INTEGER NOT NULL DEFAULT 0,
                welcomed_at INTEGER,
                last_result TEXT
            );
            """
        )
        con.commit()
    finally:
        con.close()
    align_db_owner(path)



def align_db_owner(path: Path) -> None:
    """Allinea uid/gid del db a radar.db o alla cartella data, così il servizio può scrivere."""
    refs = [DATA_DIR / "radar.db", path.parent, Path(APPDIR)]
    uid = gid = None
    for ref in refs:
        try:
            if ref.exists():
                st = ref.stat()
                uid, gid = st.st_uid, st.st_gid
                break
        except OSError:
            continue
    if uid is None:
        return
    for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        try:
            if candidate.exists():
                os.chown(candidate, uid, gid)
        except OSError:
            pass


def _column_names(con: sqlite3.Connection, table: str) -> List[str]:

    rows = con.execute(f'PRAGMA table_info("{table}")').fetchall()
    return [r[1] for r in rows]


def _safe_table_name(name: str) -> bool:
    return bool(name) and all(c.isalnum() or c == "_" for c in name)


def collect_from_sqlite(path: Path, sources: Dict[str, int]) -> Set[int]:
    found: Set[int] = set()
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as exc:
        log.warning("non leggo %s: %s", path, exc)
        return found
    try:
        tables = [
            r[0]
            for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        ]
        for table in tables:
            if not _safe_table_name(table):
                continue
            try:
                cols = _column_names(con, table)
            except sqlite3.Error:
                continue
            hit_cols = [c for c in cols if c.lower() in CHAT_ID_COLS]
            if not hit_cols:
                continue
            for col in hit_cols:
                try:
                    rows = con.execute(f'SELECT "{col}" FROM "{table}"').fetchall()
                except sqlite3.Error as exc:
                    log.warning("query %s.%s fallita: %s", path.name, col, exc)
                    continue
                n = 0
                for (val,) in rows:
                    if is_private_chat_id(val):
                        found.add(int(val))
                        n += 1
                key = f"{path}:{table}.{col}"
                sources[key] = sources.get(key, 0) + n
    finally:
        con.close()
    return found


def iter_db_files(extra: Iterable[Path] | None = None) -> List[Path]:
    paths: List[Path] = []
    seen: Set[str] = set()

    def add(p: Path) -> None:
        try:
            rp = str(p.resolve()) if p.exists() else str(p)
        except OSError:
            rp = str(p)
        if rp in seen:
            return
        if p.is_file() and p.suffix.lower() in {".db", ".sqlite", ".sqlite3"}:
            seen.add(rp)
            paths.append(p)

    add(DB_PATH)
    if DATA_DIR.is_dir():
        for p in sorted(DATA_DIR.glob("*")):
            add(p)
    # Eventuali altri sqlite accanto all'app, senza scendere in venv.
    app = Path(APPDIR)
    if app.is_dir():
        for p in app.glob("*.db"):
            add(p)
        data_alt = app / "app" / "data"
        if data_alt.is_dir():
            for p in data_alt.glob("*.db"):
                add(p)
    if extra:
        for p in extra:
            add(p)
    return paths


def already_welcomed(path: Path = DB_PATH) -> Set[int]:
    done: Set[int] = set()
    if not path.is_file():
        return done
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return done
    try:
        try:
            rows = con.execute(
                "SELECT chat_id FROM bot_users WHERE welcomed!=0"
            ).fetchall()
        except sqlite3.Error:
            return done
        for (cid,) in rows:
            if is_private_chat_id(cid):
                done.add(int(cid))
    finally:
        con.close()
    return done


def collect_chat_ids(extra: Iterable[Path] | None = None) -> Tuple[Set[int], Dict[str, int], Set[int]]:
    """Ritorna (tutti gli id, conteggi per fonte, già welcomed)."""
    sources: Dict[str, int] = {}
    all_ids: Set[int] = set()
    for path in iter_db_files(extra):
        all_ids |= collect_from_sqlite(path, sources)
    done = already_welcomed(DB_PATH)
    return all_ids, sources, done


def mark_result(chat_id: int, result: str, welcomed: bool) -> None:
    ensure_users_db(DB_PATH)
    now = int(time.time())
    con = sqlite3.connect(str(DB_PATH), timeout=10)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        if welcomed:
            con.execute(
                """
                INSERT INTO bot_users (chat_id, first_seen, welcomed, welcomed_at, last_result)
                VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET
                    welcomed=1,
                    welcomed_at=excluded.welcomed_at,
                    last_result=excluded.last_result
                """,
                (chat_id, now, now, result),
            )
        else:
            con.execute(
                """
                INSERT INTO bot_users (chat_id, first_seen, welcomed, last_result)
                VALUES (?, ?, 0, ?)
                ON CONFLICT(chat_id) DO UPDATE SET
                    last_result=excluded.last_result
                """,
                (chat_id, now, result),
            )
        con.commit()
    finally:
        con.close()
    align_db_owner(DB_PATH)


def welcome_text() -> str:
    if APPDIR not in sys.path:
        sys.path.insert(0, APPDIR)
    try:
        from app.api.bot import MSG_WELCOME as bot_msg  # type: ignore

        if isinstance(bot_msg, str) and bot_msg.strip():
            return bot_msg
    except Exception:
        pass
    return MSG_WELCOME


def welcome_keyboard():
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

    try:
        if APPDIR not in sys.path:
            sys.path.insert(0, APPDIR)
        from app.api.bot import mini_app_keyboard  # type: ignore

        return mini_app_keyboard(APP_URL)
    except Exception:
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text="🔥 Velvet Hub",
                        web_app=WebAppInfo(url=APP_URL),
                    )
                ],
                [
                    InlineKeyboardButton(text="📢 Canale", url=CHANNEL_URL),
                    InlineKeyboardButton(text="🌐 Sito", url=SITE_URL),
                ],
            ]
        )


async def send_one(bot, chat_id: int, text: str, reply_markup) -> str:
    from aiogram.exceptions import (
        TelegramBadRequest,
        TelegramForbiddenError,
        TelegramNotFound,
        TelegramRetryAfter,
        TelegramAPIError,
    )

    attempts = 0
    while attempts < 6:
        attempts += 1
        try:
            await bot.send_message(
                chat_id,
                text,
                parse_mode="HTML",
                reply_markup=reply_markup,
                disable_web_page_preview=True,
            )
            return "ok"
        except TelegramRetryAfter as exc:
            wait = int(getattr(exc, "retry_after", 1) or 1) + 1
            log.warning("RetryAfter su %s: attendo %ss", chat_id, wait)
            await asyncio.sleep(wait)
        except (TelegramForbiddenError, TelegramNotFound):
            return "blocked"
        except TelegramBadRequest as exc:
            msg = str(exc).lower()
            if any(
                s in msg
                for s in (
                    "bot was blocked",
                    "user is deactivated",
                    "chat not found",
                    "forbidden",
                    "have no rights",
                )
            ):
                return "blocked"
            log.warning("BadRequest su %s: %s", chat_id, type(exc).__name__)
            return "error"
        except TelegramAPIError as exc:
            log.warning("API error su %s: %s", chat_id, type(exc).__name__)
            return "error"
    return "error"


async def run_send(chat_ids: List[int], token: str) -> Dict[str, int]:
    from aiogram import Bot

    text = welcome_text()
    keyboard = welcome_keyboard()
    stats = {"ok": 0, "blocked": 0, "error": 0}
    bot = Bot(token=token)
    try:
        for chat_id in chat_ids:
            result = await send_one(bot, chat_id, text, keyboard)
            if result == "ok":
                mark_result(chat_id, "ok", welcomed=True)
                stats["ok"] += 1
                log.info("inviato a %s", chat_id)
            elif result == "blocked":
                # Non riprovare: l'utente ha bloccato il bot o la chat non esiste.
                mark_result(chat_id, "blocked", welcomed=True)
                stats["blocked"] += 1
                log.info("saltato %s (403/bloccato)", chat_id)
            else:
                mark_result(chat_id, "error", welcomed=False)
                stats["error"] += 1
                log.info("errore su %s (non marcato welcomed, si potrà riprovare)", chat_id)
            await asyncio.sleep(SLEEP_BETWEEN)
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass
    return stats


def report_sources(all_ids: Set[int], sources: Dict[str, int], done: Set[int]) -> List[int]:
    pending = sorted(cid for cid in all_ids if cid not in done)
    log.info("fonti chat_id privati trovate:")
    if sources:
        for key, n in sorted(sources.items()):
            log.info("  %s: %s id nuovi in questa fonte", key, n)
    else:
        log.info("  nessuna tabella con colonna chat_id/telegram_id")
    log.info("totale id privati unici: %s", len(all_ids))
    log.info("già welcomed (si saltano): %s", len(done & all_ids))
    log.info("da inviare: %s", len(pending))
    if not all_ids:
        log.info(
            "Nessun chat_id Telegram in archivio. "
            "bot.py prima di questo aggiornamento non salvava gli utenti; "
            "radar.db (mistresses/fedeli) ha handle X e nick, non chat_id Telegram. "
            "L'invio una tantum raggiunge solo chi ha già fatto /start dopo il deploy, "
            "o id trovati in altre tabelle con colonna chat_id."
        )
    return pending


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Invio una tantum del benvenuto VelvetHub (default: dry-run)."
    )
    parser.add_argument(
        "--send",
        action="store_true",
        help="Invia davvero i messaggi. Senza questo flag non parte nulla.",
    )
    args = parser.parse_args(argv)

    ensure_users_db(DB_PATH)
    all_ids, sources, done = collect_chat_ids()
    pending = report_sources(all_ids, sources, done)

    if not args.send:
        log.info("DRY-RUN: nessun messaggio inviato. Per inviare: aggiungi --send")
        return 0

    if not pending:
        log.info("Niente da inviare.")
        return 0

    token = load_token()
    if not _token_valido_len(token):
        raise SystemExit("ERRORE: token del bot non valido (il valore non viene mostrato).")

    log.info("inizio invio a %s chat", len(pending))
    stats = asyncio.run(run_send(pending, token))
    log.info(
        "fine invio: ok=%s blocked=%s error=%s",
        stats["ok"],
        stats["blocked"],
        stats["error"],
    )
    return 0 if stats["error"] == 0 else 1


def _token_valido_len(token: str) -> bool:
    return bool(token) and token != PLACEHOLDER_TOKEN


if __name__ == "__main__":
    sys.exit(main())
