"""Velvet Club · eventi, categorie, bozze X e collegamento Radar ↔ Discord.

Montato su /api/events. SQLite (stdlib) in WAL: /opt/ourvelvet/data/events.db.

- Eventi: inseriti dall'admin (contest, eventi, annunci) o generati dal Radar della Carne
  (nuovo profilo verificato, conteggio aggregato giornaliero dei nuovi Fedeli). Nessun dato
  personale: solo nomi in sala che il titolare ha reso pubblici sul Radar e numeri aggregati.
- Telegram: ogni evento nuovo va sul canale @OurVelvetHub solo se il bot è admin del canale
  con permesso di pubblicare (controllato a ogni ciclo, l'esito è in /api/events/status).
- X: per ogni evento c'è una bozza con link intent (https://x.com/intent/post?text=...).
  Il server non pubblica mai su X.
- Radar ↔ Discord: /api/events/radar-link/* verifica il token di gestione (Mistress/Master)
  o il token del Fedele, così il bot Discord assegna il ruolo solo a chi è titolare.

© 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.parse
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from app.api import radar as R

try:
    import httpx  # type: ignore
except Exception:  # pragma: no cover
    httpx = None  # type: ignore

logger = logging.getLogger("ourvelvet.events")
router = APIRouter()

DB_PATH = os.environ.get("VH_EVENTS_DB", "/opt/ourvelvet/data/events.db")
CHANNEL = "@OurVelvetHub"
SITE = "https://velvet.x-zdos.it"
RADAR_URL = SITE + "/app#radar-section"
TG_ENABLED = os.environ.get("VH_EVENTS_TG", "1") != "0"
LOOP_S = int(os.environ.get("VH_EVENTS_LOOP_S", "60"))
KINDS = ("evento", "contest", "annuncio", "radar", "info")

# Categorie del Velvet Club (Discord + tag del Radar). Descrizioni sobrie, nessun contenuto esplicito.
CATEGORIES = [
    {"slug": "bdsm-consensuale", "name": "BDSM & sado-maso consensuale", "tag": "BDSM consensuale",
     "desc": "Dominazione, bondage e sado-maso tra adulti consenzienti. Pratiche SSC/RACK, limiti dichiarati prima, safeword ROSSO."},
    {"slug": "fetish", "name": "Fetish", "tag": "Fetish",
     "desc": "Feticismi tra adulti: materiali, abbigliamento, estetiche. Rispetto dei limiti altrui, nessun giudizio."},
    {"slug": "lgbtq", "name": "LGBTQ+", "tag": "LGBTQ+",
     "desc": "Spazio per persone LGBTQ+ e alleate. Pronomi rispettati, tolleranza zero per discriminazioni."},
    {"slug": "coppie", "name": "Coppie", "tag": "Coppie",
     "desc": "Coppie di adulti che condividono contenuti come coppia: entrambi verificati 18+ e consenzienti."},
    {"slug": "solo-creator", "name": "Solo", "tag": "Solo",
     "desc": "Creator che lavorano da soli: set, sessioni e progetti personali."},
    {"slug": "mistress-master", "name": "Mistress & Master", "tag": "Mistress",
     "desc": "Le Mistress e i Master verificati sul Radar della Carne: presentazioni, regole di sala, eventi."},
    {"slug": "creator-showcase", "name": "Creator", "tag": "Creator",
     "desc": "Vetrina dei creator verificati 18+: solo i creator caricano contenuti, gli altri commentano."},
    {"slug": "asmr-audio", "name": "ASMR & audio", "tag": "ASMR audio",
     "desc": "Contenuti audio e ASMR per adulti, caricati dai creator verificati."},
    {"slug": "cosplay-adulti", "name": "Cosplay adulti", "tag": "Cosplay adulti",
     "desc": "Cosplay di adulti, interpretati da adulti. Vietati personaggi minorenni o dall'aspetto minorile."},
]
CAT_SLUGS = {c["slug"] for c in CATEGORIES}
EMOJI = {"evento": "🎟️", "contest": "🏆", "annuncio": "📢", "radar": "📡", "info": "ℹ️"}

_db_lock = threading.Lock()
_db_ready = False
_tg_state = {"checked_at": 0, "admin": None, "can_post": None, "error": None}


# ---------------------------------------------------------------- DB
def _connect() -> sqlite3.Connection:
    global _db_ready
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    if not _db_ready:
        with _db_lock:
            if not _db_ready:
                con.execute("PRAGMA journal_mode=WAL")
                con.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        kind TEXT NOT NULL,
                        category TEXT,
                        title TEXT NOT NULL,
                        body TEXT NOT NULL DEFAULT '',
                        url TEXT,
                        source TEXT NOT NULL DEFAULT 'admin',
                        source_key TEXT UNIQUE,
                        created_at INTEGER NOT NULL,
                        tg_status TEXT,
                        tg_at INTEGER
                    );
                    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
                    """
                )
                con.commit()
                _db_ready = True
    return con


def _kv_get(con, k, default=None):
    r = con.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    return r["v"] if r else default


def _kv_set(con, k, v):
    con.execute("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def _clean_text(s: Optional[str], n: int, field: str, required: bool = False) -> str:
    t = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", (s or "")).strip()
    if required and not t:
        raise HTTPException(400, f"{field}: obbligatorio.")
    if len(t) > n:
        raise HTTPException(400, f"{field}: massimo {n} caratteri.")
    if R.MINOR_RE.search(t):
        raise HTTPException(400, "Contenuto rifiutato: qui solo adulti.")
    return t


def x_text(ev: dict) -> str:
    base = f"{EMOJI.get(ev['kind'], '🖤')} {ev['title']}"
    if ev.get("body"):
        base += " — " + ev["body"]
    tail = " · VelvetHub 18+ · consenso · safeword ROSSO"
    url = ev.get("url") or SITE
    room = 280 - len(tail) - 24  # gli URL su X contano 23 caratteri
    if len(base) > room:
        base = base[: room - 1].rstrip() + "…"
    return f"{base}{tail} {url}"


def x_intent(ev: dict) -> str:
    return "https://x.com/intent/post?text=" + urllib.parse.quote(x_text(ev), safe="")


def _row(r: sqlite3.Row) -> dict:
    ev = {k: r[k] for k in ("id", "kind", "category", "title", "body", "url", "source", "created_at", "tg_status")}
    cat = next((c for c in CATEGORIES if c["slug"] == ev["category"]), None)
    ev["category_name"] = cat["name"] if cat else None
    ev["x_text"] = x_text(ev)
    ev["x_intent"] = x_intent(ev)
    return ev


def insert_event(con, kind, title, body="", url=None, category=None, source="admin", source_key=None) -> Optional[int]:
    try:
        cur = con.execute(
            "INSERT INTO events(kind, category, title, body, url, source, source_key, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (kind, category, title, body, url, source, source_key, int(time.time())),
        )
        con.commit()
        return cur.lastrowid
    except sqlite3.IntegrityError:
        return None


# ---------------------------------------------------------------- Radar → eventi
def radar_scan() -> int:
    """Nuovi profili verificati (pubblici per scelta del titolare) e conteggio aggregato dei Fedeli."""
    made = 0
    rc = R._connect()
    con = _connect()
    try:
        last = _kv_get(con, "radar_last_created")
        if last is None:  # primo avvio: niente eventi retroattivi
            mx = rc.execute("SELECT COALESCE(MAX(created_at),0) FROM mistresses").fetchone()[0]
            _kv_set(con, "radar_last_created", mx)
            con.commit()
            last = mx
        last = int(last)
        rows = rc.execute(
            "SELECT handle_lc, display_name, gender, created_at FROM mistresses WHERE hidden=0 AND created_at>? ORDER BY created_at LIMIT 20",
            (last,),
        ).fetchall()
        for m in rows:
            role = "Master" if m["gender"] == "M" else "Mistress"
            if insert_event(con, "radar", f"Nuovo profilo verificato sul Radar della Carne: {m['display_name']} ({role})",
                            "Verifica fatta con un post pubblico su X. Il profilo è nel Radar.",
                            RADAR_URL, "mistress-master", "radar", f"mistress:{m['handle_lc']}:{m['created_at']}"):
                made += 1
            last = max(last, int(m["created_at"]))
        _kv_set(con, "radar_last_created", last)
        # Aggregato giornaliero (ora di Roma): solo il numero, mai i nick.
        day = time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400))
        if _kv_get(con, "fedeli_day") != day and time.localtime().tm_hour >= 10:
            n = rc.execute("SELECT COUNT(*) FROM fedeli WHERE created_at>=?", (int(time.time()) - 86400,)).fetchone()[0]
            if n > 0 and insert_event(con, "radar", f"Radar della Carne: {n} nuov{'o' if n == 1 else 'i'} Fedel{'e' if n == 1 else 'i'} nelle ultime 24 ore",
                                      "Dato aggregato, nessun nome.", RADAR_URL, "mistress-master", "radar", f"fedeli:{day}"):
                made += 1
            _kv_set(con, "fedeli_day", day)
        con.commit()
    finally:
        con.close()
        rc.close()
    return made


# ---------------------------------------------------------------- Telegram
def _bot_token() -> str:
    try:
        from app.core.config import settings
        return settings.BOT_TOKEN or ""
    except Exception:
        return ""


async def _tg(method: str, payload: dict) -> dict:
    tok = _bot_token()
    if not tok or httpx is None:
        return {"ok": False, "description": "bot Telegram non configurato"}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"https://api.telegram.org/bot{tok}/{method}", json=payload)
        try:
            return r.json()
        except Exception:
            return {"ok": False, "description": f"HTTP {r.status_code}"}


async def tg_check() -> dict:
    try:
        me = await _tg("getMe", {})
        if not me.get("ok"):
            raise RuntimeError(me.get("description") or "getMe fallito")
        m = await _tg("getChatMember", {"chat_id": CHANNEL, "user_id": me["result"]["id"]})
        res = m.get("result") or {}
        _tg_state.update(checked_at=int(time.time()), admin=res.get("status") in ("administrator", "creator"),
                         can_post=bool(res.get("can_post_messages") or res.get("status") == "creator"), error=None if m.get("ok") else m.get("description"))
    except Exception as e:
        _tg_state.update(checked_at=int(time.time()), admin=None, can_post=None, error=type(e).__name__)
    return dict(_tg_state)


def _tg_html(ev: dict) -> str:
    from html import escape
    lines = [f"{EMOJI.get(ev['kind'], '🖤')} <b>{escape(ev['title'])}</b>"]
    if ev.get("body"):
        lines.append(escape(ev["body"]))
    if ev.get("category_name"):
        lines.append(f"<i>{escape(ev['category_name'])}</i>")
    lines.append(f"\n{escape(ev.get('url') or SITE)}")
    lines.append("18+ · consenso · safeword ROSSO")
    return "\n".join(lines)


async def tg_publish_pending() -> int:
    if not TG_ENABLED:
        return 0
    con = _connect()
    try:
        rows = [_row(r) for r in con.execute("SELECT * FROM events WHERE tg_status IS NULL ORDER BY id LIMIT 5").fetchall()]
        if not rows:
            return 0
        st = await tg_check()
        if not (st["admin"] and st["can_post"]):
            return 0  # restano in coda: verranno pubblicati quando il bot sarà admin
        sent = 0
        for ev in rows:
            r = await _tg("sendMessage", {"chat_id": CHANNEL, "text": _tg_html(ev), "parse_mode": "HTML", "disable_web_page_preview": False})
            status = "ok" if r.get("ok") else ("errore: " + str(r.get("description") or "?"))[:120]
            con.execute("UPDATE events SET tg_status=?, tg_at=? WHERE id=?", (status, int(time.time()), ev["id"]))
            con.commit()
            sent += 1 if r.get("ok") else 0
            await asyncio.sleep(2)
        return sent
    finally:
        con.close()


async def _loop() -> None:
    await asyncio.sleep(10)
    while True:
        try:
            await asyncio.to_thread(radar_scan)
            await tg_publish_pending()
        except Exception:
            logger.exception("ciclo eventi")
        await asyncio.sleep(LOOP_S)


@router.on_event("startup")
async def _start() -> None:
    if os.environ.get("VH_EVENTS_LOOP", "1") != "0":
        asyncio.get_event_loop().create_task(_loop())


# ---------------------------------------------------------------- API pubbliche (solo eventi pubblici)
@router.get("/categories")
def categories():
    return {"categories": CATEGORIES, "rules": RULES}


RULES = [
    "Solo adulti (18+) verificati.",
    "Consenso esplicito, sempre. Limiti dichiarati prima.",
    "Safeword ROSSO: ferma tutto, subito.",
    "Nessun minore, nessun personaggio dall'aspetto minorile, nessun age-play.",
    "Vietati non-consenso, incesto, violenza reale, persone reali senza il loro consenso.",
    "Solo i creator verificati 18+ caricano contenuti. Niente contatti, incontri o posizioni.",
]


@router.get("/feed")
def feed(after: int = 0, limit: int = 20):
    limit = max(1, min(limit, 50))
    con = _connect()
    try:
        rows = con.execute("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?", (after, limit)).fetchall()
        mx = con.execute("SELECT COALESCE(MAX(id),0) FROM events").fetchone()[0]
    finally:
        con.close()
    return {"events": [_row(r) for r in rows], "max_id": mx}


@router.get("/xdrafts")
def xdrafts(limit: int = 50):
    limit = max(1, min(limit, 100))
    con = _connect()
    try:
        rows = con.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    finally:
        con.close()
    return {"note": "Bozze per X: si aprono nel tuo account e le pubblichi tu. Il server non pubblica mai su X.",
            "drafts": [{k: e[k] for k in ("id", "kind", "title", "created_at", "x_text", "x_intent")} for e in map(_row, rows)]}


@router.get("/status")
def status():
    con = _connect()
    try:
        n = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        q = con.execute("SELECT COUNT(*) FROM events WHERE tg_status IS NULL").fetchone()[0]
    finally:
        con.close()
    return {"ok": True, "events": n, "telegram_queue": q, "telegram": {**_tg_state, "channel": CHANNEL, "enabled": TG_ENABLED}}


# ---------------------------------------------------------------- Admin
class EventIn(BaseModel):
    kind: str
    title: str
    body: Optional[str] = ""
    url: Optional[str] = None
    category: Optional[str] = None


@router.post("/admin")
def admin_add(body: EventIn, request: Request, x_admin_key: Optional[str] = Header(None)):
    R._admin(x_admin_key)
    R._limit(request, "evadd", 60, 3600)
    if body.kind not in KINDS:
        raise HTTPException(400, "kind: " + ", ".join(KINDS))
    if body.category and body.category not in CAT_SLUGS:
        raise HTTPException(400, "category: " + ", ".join(sorted(CAT_SLUGS)))
    url = (body.url or "").strip() or None
    if url and not re.match(r"^https://[\w.-]+(/[\w\-./?%&=#:+~]*)?$", url):
        raise HTTPException(400, "url: solo https.")
    con = _connect()
    try:
        eid = insert_event(con, body.kind, _clean_text(body.title, 120, "Titolo", True), _clean_text(body.body, 400, "Testo"), url, body.category, "admin")
        row = con.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
    finally:
        con.close()
    return {"ok": True, "event": _row(row)}


@router.delete("/admin/{eid}")
def admin_del(eid: int, x_admin_key: Optional[str] = Header(None)):
    R._admin(x_admin_key)
    con = _connect()
    try:
        con.execute("DELETE FROM events WHERE id=?", (eid,))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


# ---------------------------------------------------------------- Radar ↔ Discord
class LinkIn(BaseModel):
    kind: str  # mistress | fedele
    handle: Optional[str] = None
    fedele_id: Optional[int] = None
    token: str


def _link_role(con, kind, handle=None, fedele_id=None, token=None) -> dict:
    if kind == "mistress":
        h = R._handle(handle)
        row = con.execute("SELECT * FROM mistresses WHERE handle_lc=?", (h.lower(),)).fetchone()
        if not row:
            return {"exists": False}
        if token is not None and not hmac.compare_digest(row["manage_hash"], R._h(token)):
            raise HTTPException(403, "Token di gestione non valido.")
        return {"exists": True, "hidden": bool(row["hidden"]), "role": "Master" if row["gender"] == "M" else "Mistress",
                "name": row["display_name"], "ref": h.lower()}
    if kind == "fedele":
        row = con.execute("SELECT * FROM fedeli WHERE id=?", (int(fedele_id or 0),)).fetchone()
        if not row:
            return {"exists": False}
        if token is not None and not hmac.compare_digest(row["delete_hash"], R._h(token)):
            raise HTTPException(403, "Token del Fedele non valido.")
        m = con.execute("SELECT hidden FROM mistresses WHERE handle_lc=?", (row["mistress_lc"],)).fetchone()
        return {"exists": True, "hidden": bool(m["hidden"]) if m else True, "role": "Fedele", "name": row["nick"], "ref": str(row["id"])}
    raise HTTPException(400, "kind: mistress o fedele")


@router.post("/radar-link/check")
def radar_link_check(body: LinkIn, request: Request):
    R._limit(request, "rlink", 10, 3600, gap=2)
    con = R._connect()
    try:
        r = _link_role(con, body.kind, body.handle, body.fedele_id, body.token or "")
    finally:
        con.close()
    if not r.get("exists"):
        raise HTTPException(404, "Profilo non trovato sul Radar.")
    return {"ok": True, **r}


@router.get("/radar-link/state")
def radar_link_state(kind: str, ref: str, request: Request):
    """Stato attuale (esiste/nascosto) di un collegamento già verificato: serve al bot per togliere il ruolo."""
    R._limit(request, "rstate", 600, 3600)
    con = R._connect()
    try:
        r = _link_role(con, kind, ref if kind == "mistress" else None, int(ref) if kind == "fedele" and ref.isdigit() else None, None)
    finally:
        con.close()
    return {"ok": True, "exists": r.get("exists", False), "hidden": r.get("hidden", False), "role": r.get("role")}
