"""Webhook Telegram per @RedVelvetOfficial_bot (VelvetHub 18+ by ZDOS1.3)."""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import threading
import time

from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command, CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from fastapi import APIRouter, HTTPException, Request

from app.core.config import settings

logger = logging.getLogger("ourvelvet.bot")

APP_URL = "https://velvet.x-zdos.it/app"
SITE_URL = "https://velvet.x-zdos.it"
CHANNEL_URL = "https://t.me/OurVelvetHub"
CHANNEL_USERNAME = "OurVelvetHub"
WEBHOOK_URL_DEFAULT = "https://velvet.x-zdos.it/api/bot/webhook"
VELVET_MINT = "2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump"
PLACEHOLDER_TOKEN = "INSERISCI_IL_TUO_BOT_TOKEN"
DB_PATH = os.environ.get("VH_BOT_USERS_DB", "/opt/ourvelvet/data/bot_users.db")

# Update che il webhook deve accettare. chat_join_request è obbligatorio
# per le richieste d'ingresso al canale: se allowed_updates è una lista
# ristretta che lo esclude, Telegram non consegna l'evento.
ALLOWED_UPDATES = [
    "message",
    "edited_message",
    "callback_query",
    "chat_join_request",
    "my_chat_member",
]

# Ancore verificate in app.html: Creator Hub, notizie, sezione VELVET, radio Lo-Fi.
URL_HUB = APP_URL
URL_CREATOR = f"{APP_URL}#creator-fan-hub"
URL_FEED = f"{APP_URL}#women-news-feed"
URL_WALLET = f"{APP_URL}#home-ov"
URL_RADIO = f"{APP_URL}#lofi-widget"

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

MSG_START = (
    "🍷 Benvenuto in <b>VelvetHub</b> 18+ by ZDOS1.3.\n"
    "\n"
    "Premendo Avvia confermi di essere maggiorenne.\n"
    "\n"
    "📜 Regole\n"
    "• Solo maggiorenni (18+)\n"
    "• Consenso sempre, safeword ROSSO\n"
    "• Niente incontri reali organizzati qui, niente posizioni\n"
    "• Rispetto per tutti\n"
    "\n"
    "VELVET è il token della community: niente rendimenti e niente promesse di guadagno.\n"
    "\n"
    "Apri la Mini App per entrare nella sala."
)

MSG_HUB = (
    "Questa è la Mini App di <b>VelvetHub</b> 18+ by ZDOS1.3: "
    "sala, Radar, Creator Hub, Smartshop e radio.\n"
    "\n"
    "Solo maggiorenni. Consenso sempre, safeword ROSSO."
)

MSG_WALLET = (
    "Nella Mini App puoi collegare <b>Phantom</b> in sola lettura, "
    "dal pulsante in alto o dalla sezione VELVET.\n"
    "\n"
    "Il bot non chiede mai la seed phrase né le chiavi private e non muove fondi.\n"
    "\n"
    "Mint di VELVET (Solana):\n"
    f"<code>{VELVET_MINT}</code>\n"
    "\n"
    "Niente rendimenti e niente promesse di guadagno."
)

MSG_CREATOR = (
    "Il <b>Creator Hub</b> è la sezione della Mini App per i contenuti "
    "della community e i contest.\n"
    "\n"
    "Apri la Mini App per entrarci."
)

MSG_RADIO = (
    "Nella Mini App trovi la radio Lo-Fi in basso a destra. "
    "Puoi avviarla o metterla in pausa da lì."
)

MSG_FEED = (
    "Nella Mini App, la sezione notizie raccoglie il feed 18+ "
    "e i contributi della community."
)

MSG_HELP = (
    "Comandi di <b>VelvetHub</b> 18+ by ZDOS1.3:\n"
    "\n"
    "/start — benvenuto e regole\n"
    "/hub — apri la Mini App\n"
    "/wallet — Phantom in sola lettura e mint VELVET\n"
    "/creator — Creator Hub\n"
    "/radio — radio della Mini App\n"
    "/feed — notizie e feed\n"
    "/help — questo messaggio\n"
    "\n"
    "📜 Regole: solo maggiorenni (18+), consenso sempre, safeword ROSSO, "
    "niente incontri reali, niente posizioni.\n"
    "\n"
    "Canale: @OurVelvetHub\n"
    f"Sito: {SITE_URL}"
)

router = APIRouter()
bot: Bot | None = None
dp = Dispatcher()

_db_lock = threading.RLock()
_db_ready = False
_channel_id: int | None = None
_channel_lock: asyncio.Lock | None = None


def _get_channel_lock() -> asyncio.Lock:
    global _channel_lock
    if _channel_lock is None:
        _channel_lock = asyncio.Lock()
    return _channel_lock


def _token_valido(token: str | None) -> bool:
    return bool(token) and token != PLACEHOLDER_TOKEN


def mini_app_keyboard(app_url: str = APP_URL) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🔥 Velvet Hub",
                    web_app=WebAppInfo(url=app_url),
                )
            ],
            [
                InlineKeyboardButton(text="📢 Canale", url=CHANNEL_URL),
                InlineKeyboardButton(text="🌐 Sito", url=SITE_URL),
            ],
        ]
    )


def _is_private_chat(message: types.Message) -> bool:
    chat = message.chat
    if chat is None:
        return False
    kind = getattr(chat, "type", None)
    value = kind.value if hasattr(kind, "value") else kind
    return str(value) == "private"


def _connect_users() -> sqlite3.Connection:
    global _db_ready
    parent = os.path.dirname(DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=5000")
    if not _db_ready:
        with _db_lock:
            if not _db_ready:
                con.execute("PRAGMA journal_mode=WAL")
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
                _db_ready = True
    return con


def register_start(chat_id: int) -> bool:
    """Registra l'utente. True se è il primo /start o se non si riesce a distinguere."""
    if not isinstance(chat_id, int) or chat_id <= 0:
        return True
    now = int(time.time())
    try:
        with _db_lock:
            con = _connect_users()
            try:
                row = con.execute(
                    "SELECT welcomed FROM bot_users WHERE chat_id=?",
                    (chat_id,),
                ).fetchone()
                if row is None:
                    con.execute(
                        "INSERT INTO bot_users (chat_id, first_seen, welcomed) VALUES (?, ?, 0)",
                        (chat_id, now),
                    )
                    con.commit()
                    return True
                # Già in archivio ma messaggio non ancora recapitato: riprova il benvenuto EN.
                return int(row["welcomed"] or 0) == 0
            finally:
                con.close()
    except Exception:
        logger.exception("bot_users: registrazione fallita")
        return True


def mark_welcomed(chat_id: int, result: str = "ok") -> None:
    if not isinstance(chat_id, int) or chat_id <= 0:
        return
    now = int(time.time())
    try:
        with _db_lock:
            con = _connect_users()
            try:
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
                con.commit()
            finally:
                con.close()
    except Exception:
        logger.exception("bot_users: mark_welcomed fallito")


def mark_result(chat_id: int, result: str, welcomed: bool) -> None:
    """Salva il chat_id. welcomed=True solo se il benvenuto è partito."""
    if not isinstance(chat_id, int) or chat_id <= 0:
        return
    now = int(time.time())
    try:
        with _db_lock:
            con = _connect_users()
            try:
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
                    # Inserisce se manca; se esiste già non azzera un welcomed=1.
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
    except Exception:
        logger.exception("bot_users: mark_result fallito")


async def _rispondi(message: types.Message, text: str, app_url: str = APP_URL) -> None:
    await message.answer(
        text,
        parse_mode="HTML",
        reply_markup=mini_app_keyboard(app_url),
        disable_web_page_preview=True,
    )


@dp.message(CommandStart())
async def cmd_start(message: types.Message) -> None:
    first = True
    chat_id = message.chat.id if message.chat is not None else None
    private = _is_private_chat(message)
    if private and isinstance(chat_id, int) and chat_id > 0:
        first = register_start(chat_id)
    # Primo /start (o se non si distingue): testo inglese approvato.
    # /start successivi: messaggio già in uso, stessi pulsanti.
    text = MSG_WELCOME if first else MSG_START
    await _rispondi(message, text, URL_HUB)
    if first and private and isinstance(chat_id, int) and chat_id > 0:
        mark_welcomed(chat_id, "ok")


@dp.message(Command("hub"))
async def cmd_hub(message: types.Message) -> None:
    await _rispondi(message, MSG_HUB, URL_HUB)


@dp.message(Command("wallet"))
async def cmd_wallet(message: types.Message) -> None:
    await _rispondi(message, MSG_WALLET, URL_WALLET)


@dp.message(Command("creator"))
async def cmd_creator(message: types.Message) -> None:
    await _rispondi(message, MSG_CREATOR, URL_CREATOR)


@dp.message(Command("radio"))
async def cmd_radio(message: types.Message) -> None:
    await _rispondi(message, MSG_RADIO, URL_RADIO)


@dp.message(Command("feed"))
async def cmd_feed(message: types.Message) -> None:
    await _rispondi(message, MSG_FEED, URL_FEED)


@dp.message(Command("help"))
async def cmd_help(message: types.Message) -> None:
    await _rispondi(message, MSG_HELP, URL_HUB)


# ---------------------------------------------------------------- canale: richieste d'ingresso
def _chat_username(chat: object) -> str:
    uname = getattr(chat, "username", None) or ""
    return str(uname).lstrip("@")


def is_velvet_channel_chat(chat: object, resolved_id: int | None = None) -> bool:
    """True solo per @OurVelvetHub (username oppure id risolto con get_chat)."""
    if chat is None:
        return False
    if _chat_username(chat).lower() == CHANNEL_USERNAME.lower():
        return True
    cid = getattr(chat, "id", None)
    if resolved_id is not None and cid is not None and int(cid) == int(resolved_id):
        return True
    return False


async def resolve_channel_id(bot_obj: Bot) -> int | None:
    """Risolve e memorizza l'id di @OurVelvetHub. Non approva altri chat."""
    global _channel_id
    if _channel_id is not None:
        return _channel_id
    async with _get_channel_lock():
        if _channel_id is not None:
            return _channel_id
        try:
            chat = await bot_obj.get_chat(f"@{CHANNEL_USERNAME}")
            _channel_id = int(chat.id)
            logger.info("canale @%s id=%s", CHANNEL_USERNAME, _channel_id)
            return _channel_id
        except Exception:
            logger.exception("get_chat @%s fallito", CHANNEL_USERNAME)
            return None


async def _approve_join_request(event: types.ChatJoinRequest) -> bool:
    """Approva. True se ok o se era già stata gestita."""
    from aiogram.exceptions import (
        TelegramBadRequest,
        TelegramForbiddenError,
        TelegramRetryAfter,
        TelegramAPIError,
    )

    try:
        await event.approve()
        return True
    except TelegramRetryAfter as exc:
        wait = int(getattr(exc, "retry_after", 1) or 1) + 1
        logger.warning("approve RetryAfter, attendo %ss", wait)
        await asyncio.sleep(wait)
        try:
            await event.approve()
            return True
        except Exception:
            logger.exception("approve dopo RetryAfter fallito")
            return False
    except TelegramBadRequest as exc:
        msg = str(exc).lower()
        if any(
            s in msg
            for s in (
                "already",
                "processed",
                "user is already a member",
                "already participant",
                "hide_requester",
            )
        ):
            logger.info("richiesta già approvata o utente già iscritto")
            return True
        logger.warning("approve BadRequest: %s", type(exc).__name__)
        return False
    except TelegramForbiddenError:
        logger.warning(
            "approve 403: il bot non è admin del canale o manca il permesso Aggiungi iscritti"
        )
        return False
    except TelegramAPIError:
        logger.exception("approve API error")
        return False


async def _send_join_welcome(bot_obj: Bot, chat_id: int) -> str:
    """Invia il benvenuto in privato. Ritorna ok / blocked / error."""
    from aiogram.exceptions import (
        TelegramBadRequest,
        TelegramForbiddenError,
        TelegramNotFound,
        TelegramRetryAfter,
        TelegramAPIError,
    )

    attempts = 0
    while attempts < 4:
        attempts += 1
        try:
            await bot_obj.send_message(
                chat_id,
                MSG_WELCOME,
                parse_mode="HTML",
                reply_markup=mini_app_keyboard(URL_HUB),
                disable_web_page_preview=True,
            )
            return "ok"
        except TelegramRetryAfter as exc:
            wait = int(getattr(exc, "retry_after", 1) or 1) + 1
            logger.warning("welcome RetryAfter su %s, attendo %ss", chat_id, wait)
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
                    "can't initiate",
                    "peer_id_invalid",
                )
            ):
                return "blocked"
            logger.warning("welcome BadRequest su %s: %s", chat_id, type(exc).__name__)
            return "error"
        except TelegramAPIError:
            logger.exception("welcome API error su %s", chat_id)
            return "error"
    return "error"


def _join_target_chat_id(event: types.ChatJoinRequest) -> int | None:
    """chat_id privato a cui scrivere: user_chat_id, poi from_user.id se positivo."""
    uid = getattr(event, "user_chat_id", None)
    if isinstance(uid, int) and uid > 0:
        return uid
    user = getattr(event, "from_user", None)
    fid = getattr(user, "id", None) if user is not None else None
    if isinstance(fid, int) and fid > 0:
        return fid
    return None


@dp.chat_join_request()
async def on_chat_join_request(event: types.ChatJoinRequest) -> None:
    """Approva le richieste a @OurVelvetHub e manda il benvenuto in privato."""
    bot_obj = event.bot if getattr(event, "bot", None) is not None else bot
    if bot_obj is None:
        logger.warning("join request senza istanza bot, ignoro")
        return

    resolved = await resolve_channel_id(bot_obj)
    if not is_velvet_channel_chat(event.chat, resolved):
        logger.info(
            "join request ignorata: chat_id=%s username=%s (solo @%s)",
            getattr(event.chat, "id", None),
            _chat_username(event.chat),
            CHANNEL_USERNAME,
        )
        return

    approved = await _approve_join_request(event)
    if not approved:
        logger.warning("ingresso non approvato (si tenta comunque il benvenuto in privato)")
    chat_id = _join_target_chat_id(event)
    if chat_id is None:
        logger.warning("join request senza user_chat_id, benvenuto non inviato")
        return

    mark_result(chat_id, "pending", welcomed=False)
    result = await _send_join_welcome(bot_obj, chat_id)
    if result == "ok":
        mark_result(chat_id, "ok", welcomed=True)
        logger.info("benvenuto inviato dopo join request a %s (approved=%s)", chat_id, approved)
    else:
        mark_result(chat_id, result, welcomed=False)
        logger.warning(
            "benvenuto non recapitato a %s (%s); richiesta approvata=%s",
            chat_id,
            result,
            approved,
        )


# ---------------------------------------------------------------- webhook allowed_updates
def _webhook_url_from_config() -> str:
    for key in ("WEBHOOK_URL", "BOT_WEBHOOK_URL", "VH_BOT_WEBHOOK_URL"):
        val = os.environ.get(key)
        if val:
            return val.strip()
    for key in ("WEBHOOK_URL", "BOT_WEBHOOK_URL", "VH_BOT_WEBHOOK_URL"):
        val = getattr(settings, key, None)
        if val:
            return str(val).strip()
    return WEBHOOK_URL_DEFAULT


def _webhook_secret_from_config() -> str | None:
    for key in ("WEBHOOK_SECRET", "BOT_WEBHOOK_SECRET", "VH_WEBHOOK_SECRET"):
        val = os.environ.get(key) or getattr(settings, key, None)
        if val:
            return str(val)
    return None


def _allowed_covers_join(allowed: object) -> bool:
    """True se Telegram consegna già chat_join_request (lista vuota = default)."""
    if not allowed:
        return True
    names = [str(x) for x in allowed]
    return "chat_join_request" in names


def _public_webhook_line(info: object, note: str = "") -> str:
    url = getattr(info, "url", "") or ""
    allowed = getattr(info, "allowed_updates", None)
    pending = getattr(info, "pending_update_count", None)
    last_err = getattr(info, "last_error_message", None)
    last_date = getattr(info, "last_error_date", None)
    if not allowed:
        allowed_s = "[] (default: include chat_join_request)"
    else:
        allowed_s = "[" + ", ".join(str(x) for x in allowed) + "]"
    parts = [
        f"webhook_url={url or '(vuoto)'}",
        f"allowed_updates={allowed_s}",
        f"pending={pending}",
    ]
    if last_err:
        parts.append(f"last_error={last_err}")
    if last_date:
        parts.append(f"last_error_date={last_date}")
    if note:
        parts.append(note)
    return " ".join(parts)


async def ensure_webhook(bot_obj: Bot | None = None) -> str:
    """Allinea allowed_updates se manca chat_join_request. Non stampa il token.

    Se il webhook è già impostato e la lista è vuota o già contiene
    chat_join_request, non chiama setWebhook (così un eventuale secret
    token già configurato resta intatto).
    """
    bot_obj = bot_obj or bot
    if bot_obj is None:
        return "ERRORE: bot non configurato (token assente)"
    info = await bot_obj.get_webhook_info()
    allowed = getattr(info, "allowed_updates", None)
    url = (getattr(info, "url", None) or "").strip() or _webhook_url_from_config()
    if url and _allowed_covers_join(allowed):
        return _public_webhook_line(info, note="nessuna modifica")

    kwargs = {
        "url": url or _webhook_url_from_config(),
        "allowed_updates": ALLOWED_UPDATES,
        "drop_pending_updates": False,
    }
    secret = _webhook_secret_from_config()
    if secret:
        kwargs["secret_token"] = secret
    await bot_obj.set_webhook(**kwargs)
    info2 = await bot_obj.get_webhook_info()
    return _public_webhook_line(info2, note="webhook aggiornato")


@router.on_event("startup")
async def _on_startup_webhook() -> None:
    if not bot:
        logger.warning("startup: bot non configurato, webhook non verificato")
        return
    try:
        line = await ensure_webhook(bot)
        logger.info("webhook: %s", line)
    except Exception:
        logger.exception("verifica/impostazione webhook fallita")


if _token_valido(getattr(settings, "BOT_TOKEN", None)):
    bot = Bot(token=settings.BOT_TOKEN)


def _parse_update(payload: dict) -> types.Update:
    try:
        return types.Update.model_validate(payload, context={"bot": bot})
    except TypeError:
        return types.Update.model_validate(payload)


@router.post("/webhook")
async def telegram_webhook(request: Request):
    """Webhook Telegram Bot."""
    if not bot or not dp:
        raise HTTPException(status_code=503, detail="Bot not configured")

    update = await request.json()
    try:
        telegram_update = _parse_update(update)
        await dp.feed_update(bot, telegram_update)
    except Exception:
        logger.exception("webhook handler failed")
    return {"ok": True}


def cli_webhook() -> int:
    """Usato da applica-join.sh: stampa allowed_updates, aggiorna se serve. Mai il token."""
    if not bot:
        print("ERRORE: bot non configurato (token assente, valore non mostrato)")
        return 1
    try:
        line = asyncio.run(ensure_webhook(bot))
        print(line)
        return 0
    except Exception as exc:
        print("ERRORE webhook:", type(exc).__name__)
        return 1


if __name__ == "__main__":
    raise SystemExit(cli_webhook())
