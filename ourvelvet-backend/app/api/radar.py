"""Radar della Carne: profili Mistress verificati via post X (oEmbed) e Fedeli salvati.

Montato su /api/radar. SQLite (stdlib) in WAL. Niente API key di X, niente lettura follower,
niente posizione/contatti. Si salva solo quanto spiegato nella pagina; tutto si cancella quando vuoi.
Admin: env VH_ADMIN_KEY_SHA256 (consigliato, solo l'hash) oppure VH_ADMIN_KEY.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from typing import Deque, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()

DB_PATH = os.environ.get("VH_RADAR_DB", "/opt/ourvelvet/data/radar.db")
CODE_TTL = 30 * 60
REG_TTL = 30 * 60
CODE_MAX_TRIES = 8
OEMBED_URLS = ("https://publish.x.com/oembed", "https://publish.twitter.com/oembed")
OEMBED_TIMEOUT = 10
PER_PAGE_MAX = 30

HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
POST_RE = re.compile(
    r"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})/status(?:es)?/(\d{5,25})(?:[/?#].*)?$",
    re.IGNORECASE,
)
GENDERS = ("F", "M", "altro")
CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

MINOR_RE = re.compile(
    r"\b(teenagers?|teens?|children|child|kids?|minors?|underage|under-age|loli|lolita|shota|jailbait|"
    r"pedophil\w*|paedophil\w*|pedo|csam|preteens?|pre-teens?|schoolgirls?|schoolboys?|"
    r"\d{1,2}[ -]years?[ -]old|bambin[ioae]|minorenn[ie]|pedofil\w*|ragazzin[ioae]|"
    r"adolescent[ie]|scolar[ie]|liceal[ie]|(?:1[0-7]|[1-9])\s*enn[ie]|ho\s+(?:1[0-7]|[1-9])\s*anni)\b",
    re.IGNORECASE,
)
# Niente contatti, link o posizioni nei testi pubblici.
CONTACT_RE = re.compile(
    r"(https?://|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\+?\d[\d .\-]{7,}\d|t\.me/|wa\.me/|whatsapp|telegram|"
    r"onlyfans\.com|snapchat|\bsnap:)",
    re.IGNORECASE,
)

_db_lock = threading.Lock()
_db_ready = False


# ---------------------------------------------------------------- DB
def _connect() -> sqlite3.Connection:
    global _db_ready
    con = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=5000")
    if not _db_ready:
        with _db_lock:
            if not _db_ready:
                con.execute("PRAGMA journal_mode=WAL")
                con.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS codes (
                        handle_lc TEXT PRIMARY KEY,
                        handle TEXT NOT NULL,
                        code TEXT NOT NULL,
                        expires_at INTEGER NOT NULL,
                        tries INTEGER NOT NULL DEFAULT 0,
                        reg_hash TEXT,
                        reg_expires INTEGER,
                        post_url TEXT
                    );
                    CREATE TABLE IF NOT EXISTS mistresses (
                        handle_lc TEXT PRIMARY KEY,
                        handle TEXT NOT NULL,
                        display_name TEXT NOT NULL,
                        gender TEXT NOT NULL DEFAULT 'F',
                        bio TEXT NOT NULL DEFAULT '',
                        tags TEXT NOT NULL DEFAULT '[]',
                        avatar INTEGER NOT NULL DEFAULT 0,
                        post_url TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        manage_hash TEXT NOT NULL,
                        hidden INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE INDEX IF NOT EXISTS ix_m_created ON mistresses(hidden, created_at DESC);
                    CREATE TABLE IF NOT EXISTS fedeli (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        mistress_lc TEXT NOT NULL,
                        nick TEXT NOT NULL,
                        nick_lc TEXT NOT NULL,
                        x_handle TEXT,
                        public INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL,
                        delete_hash TEXT NOT NULL,
                        UNIQUE(mistress_lc, nick_lc)
                    );
                    CREATE INDEX IF NOT EXISTS ix_f_m ON fedeli(mistress_lc);
                    CREATE TABLE IF NOT EXISTS reports (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        kind TEXT NOT NULL,
                        target TEXT NOT NULL,
                        reason TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        done INTEGER NOT NULL DEFAULT 0
                    );
                    """
                )
                con.commit()
                _db_ready = True
    return con


def _h(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> int:
    return int(time.time())


# ---------------------------------------------------------------- limiti
_hits: Dict[str, Deque[float]] = {}
_hits_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    host = request.client.host if request.client else ""
    if host in ("127.0.0.1", "::1", ""):
        h = request.headers.get("x-real-ip") or (request.headers.get("x-forwarded-for") or "").split(",")[0]
        host = (h or host or "?").strip()
    return host


def _limit(request: Request, name: str, max_n: int, window: int, gap: float = 0.0) -> None:
    key = name + "|" + _client_ip(request)
    now = time.time()
    with _hits_lock:
        q = _hits.setdefault(key, deque())
        while q and now - q[0] > window:
            q.popleft()
        if gap and q and now - q[-1] < gap:
            raise HTTPException(429, "Piano. Aspetta qualche secondo.")
        if len(q) >= max_n:
            raise HTTPException(429, "Troppe richieste. Riprova più tardi.")
        q.append(now)
        if len(_hits) > 20000:
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 3600]:
                _hits.pop(k, None)


# ---------------------------------------------------------------- validazione
def _text(s: Optional[str], max_len: int, field: str, required: bool = False, multiline: bool = False) -> str:
    s = unicodedata.normalize("NFC", s or "")
    s = "".join(ch for ch in s if (ch == "\n" and multiline) or unicodedata.category(ch)[0] != "C")
    s = s.replace("<", "").replace(">", "")  # difesa in profondità: la pagina comunque fa escape
    s = re.sub(r"[ \t]+", " ", s).strip()
    if multiline:
        s = re.sub(r"\n{3,}", "\n\n", s)
    if required and not s:
        raise HTTPException(400, f"Campo obbligatorio: {field}.")
    if len(s) > max_len:
        raise HTTPException(400, f"{field}: massimo {max_len} caratteri.")
    if MINOR_RE.search(s):
        raise HTTPException(400, "Niente riferimenti a minori. Solo adulti 18+.")
    if CONTACT_RE.search(s):
        raise HTTPException(400, f"{field}: niente link, contatti, numeri o indirizzi.")
    return s


def _handle(s: Optional[str]) -> str:
    h = (s or "").strip().lstrip("@").strip()
    if not HANDLE_RE.match(h):
        raise HTTPException(400, "Handle X non valido (lettere, numeri e _ fino a 15).")
    return h


def _tags(tags: Optional[List[str]]) -> List[str]:
    out: List[str] = []
    for t in (tags or [])[:12]:
        t = _text((t or "")[:24], 24, "Tag")
        t = re.sub(r"[^\w \-+&'·]", "", t, flags=re.UNICODE).strip()
        if t and t.lower() not in [x.lower() for x in out]:
            out.append(t)
    return out[:8]


def _profile(row: sqlite3.Row, con: sqlite3.Connection, full: bool = False) -> dict:
    lc = row["handle_lc"]
    n = con.execute("SELECT COUNT(*) FROM fedeli WHERE mistress_lc=?", (lc,)).fetchone()[0]
    d = {
        "handle": row["handle"],
        "display_name": row["display_name"],
        "gender": row["gender"],
        "bio": row["bio"],
        "tags": json.loads(row["tags"] or "[]"),
        "avatar": bool(row["avatar"]),
        "verified": True,
        "post_url": row["post_url"],
        "created_at": row["created_at"],
        "fedeli_count": n,
    }
    if full:
        pubs = con.execute(
            "SELECT nick FROM fedeli WHERE mistress_lc=? AND public=1 ORDER BY created_at DESC LIMIT 50", (lc,)
        ).fetchall()
        d["fedeli_public"] = [r["nick"] for r in pubs]
    return d


# ---------------------------------------------------------------- oEmbed
def _oembed(post_url: str) -> Optional[dict]:
    """None = X non raggiungibile; {} = post non trovato/non pubblico; dict = ok."""
    last_err = None
    for base in OEMBED_URLS:
        q = urllib.parse.urlencode({"url": post_url, "omit_script": "1", "dnt": "true"})
        req = urllib.request.Request(base + "?" + q, headers={"User-Agent": "VelvetHub/1.0 (+https://velvet.x-zdos.it)"})
        try:
            with urllib.request.urlopen(req, timeout=OEMBED_TIMEOUT) as r:  # nosec - URL fisso
                return json.loads(r.read(200_000).decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404, 410):
                return {}
            last_err = e
        except Exception as e:  # rete, timeout, JSON
            last_err = e
    return None if last_err is not None else {}


# ---------------------------------------------------------------- modelli
class CodeIn(BaseModel):
    handle: str


class VerifyIn(BaseModel):
    handle: str
    post_url: str


class MistressIn(BaseModel):
    reg_token: Optional[str] = None
    display_name: str
    gender: str = "F"
    bio: str = ""
    tags: List[str] = []
    avatar: bool = True
    adult: bool = False
    consent: bool = False
    owner: bool = False


class FedeleIn(BaseModel):
    mistress: str
    nick: str
    x_handle: Optional[str] = None
    public: bool = False
    adult: bool = False


class ReportIn(BaseModel):
    kind: str
    target: str
    reason: str = ""


# ---------------------------------------------------------------- verifica
@router.post("/code")
def make_code(body: CodeIn, request: Request):
    _limit(request, "code", 6, 3600, gap=3)
    h = _handle(body.handle)
    code = "VELVET-" + "".join(secrets.choice(CODE_ALPHA) for _ in range(6))
    exp = _now() + CODE_TTL
    con = _connect()
    try:
        con.execute(
            "INSERT INTO codes(handle_lc, handle, code, expires_at, tries) VALUES(?,?,?,?,0) "
            "ON CONFLICT(handle_lc) DO UPDATE SET handle=excluded.handle, code=excluded.code, "
            "expires_at=excluded.expires_at, tries=0, reg_hash=NULL, reg_expires=NULL, post_url=NULL",
            (h.lower(), h, code, exp),
        )
        con.execute("DELETE FROM codes WHERE expires_at < ? AND (reg_expires IS NULL OR reg_expires < ?)", (_now(), _now()))
        con.commit()
    finally:
        con.close()
    text = f"Sono Mistress su VelvetHub 18+ #VelvetHub {code}"
    return {"handle": h, "code": code, "expires_at": exp, "post_text": text}


@router.post("/verify")
def verify(body: VerifyIn, request: Request):
    _limit(request, "verify", 12, 3600, gap=4)
    h = _handle(body.handle)
    url = (body.post_url or "").strip()[:300]
    m = POST_RE.match(url)
    if not m:
        raise HTTPException(400, "Incolla il link del post, tipo https://x.com/tuohandle/status/123…")
    con = _connect()
    try:
        row = con.execute("SELECT * FROM codes WHERE handle_lc=?", (h.lower(),)).fetchone()
        if not row or row["expires_at"] < _now():
            raise HTTPException(410, "Codice scaduto o mancante. Chiedine uno nuovo.")
        if row["tries"] >= CODE_MAX_TRIES:
            raise HTTPException(429, "Troppi tentativi con questo codice. Chiedine uno nuovo.")
        canon = f"https://twitter.com/{m.group(1)}/status/{m.group(2)}"
        data = _oembed(canon)
        if data is None:
            raise HTTPException(503, "X non risponde in questo momento. Il codice resta valido: riprova tra un minuto.")
        con.execute("UPDATE codes SET tries=tries+1 WHERE handle_lc=?", (h.lower(),))
        con.commit()
        if not data:
            raise HTTPException(404, "Post non trovato. Controlla che sia pubblico (account non protetto) e che il link sia giusto, poi riprova.")
        author = str(data.get("author_url") or "")
        if not re.fullmatch(r"https?://(?:www\.)?(?:x|twitter)\.com/" + re.escape(h) + r"/?", author, re.IGNORECASE):
            raise HTTPException(403, f"Il post non è dell'account @{h}. Pubblicalo da @{h}.")
        if row["code"].lower() not in str(data.get("html") or "").lower():
            raise HTTPException(403, "Nel post non trovo il codice. Pubblica il testo esatto con il codice e riprova.")
        reg = secrets.token_urlsafe(24)
        con.execute(
            "UPDATE codes SET reg_hash=?, reg_expires=?, post_url=?, expires_at=0 WHERE handle_lc=?",
            (_h(reg), _now() + REG_TTL, f"https://x.com/{h}/status/{m.group(2)}", h.lower()),
        )
        con.commit()
        exists = con.execute("SELECT 1 FROM mistresses WHERE handle_lc=?", (h.lower(),)).fetchone() is not None
    finally:
        con.close()
    return {"verified": True, "handle": h, "reg_token": reg, "existing_profile": exists}


# ---------------------------------------------------------------- profilo Mistress
def _check_fields(body: MistressIn) -> dict:
    if not (body.adult and body.consent and body.owner):
        raise HTTPException(400, "Devi confermare 18+, regole di consenso e di essere titolare dell'account X.")
    g = body.gender if body.gender in GENDERS else None
    if not g:
        raise HTTPException(400, "Genere: F, M o altro.")
    return {
        "display_name": _text(body.display_name, 40, "Nome in sala", required=True),
        "gender": g,
        "bio": _text(body.bio, 280, "Bio", multiline=True),
        "tags": json.dumps(_tags(body.tags), ensure_ascii=False),
        "avatar": 1 if body.avatar else 0,
    }


@router.post("/mistress")
def create_mistress(body: MistressIn, request: Request):
    _limit(request, "msave", 10, 3600, gap=2)
    if not body.reg_token:
        raise HTTPException(401, "Prima verifica l'handle con il post.")
    f = _check_fields(body)
    con = _connect()
    try:
        row = con.execute(
            "SELECT * FROM codes WHERE reg_hash=? AND reg_expires>=?", (_h(body.reg_token), _now())
        ).fetchone()
        if not row:
            raise HTTPException(401, "Verifica scaduta. Rifai la verifica con un nuovo codice.")
        manage = secrets.token_urlsafe(24)
        now = _now()
        con.execute(
            "INSERT INTO mistresses(handle_lc, handle, display_name, gender, bio, tags, avatar, post_url, created_at, updated_at, manage_hash, hidden) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(handle_lc) DO UPDATE SET handle=excluded.handle, "
            "display_name=excluded.display_name, gender=excluded.gender, bio=excluded.bio, tags=excluded.tags, "
            "avatar=excluded.avatar, post_url=excluded.post_url, updated_at=excluded.updated_at, manage_hash=excluded.manage_hash",
            (row["handle_lc"], row["handle"], f["display_name"], f["gender"], f["bio"], f["tags"], f["avatar"],
             row["post_url"], now, now, _h(manage)),
        )
        con.execute("DELETE FROM codes WHERE handle_lc=?", (row["handle_lc"],))
        con.commit()
        m = con.execute("SELECT * FROM mistresses WHERE handle_lc=?", (row["handle_lc"],)).fetchone()
        prof = _profile(m, con, full=True)
        hidden = bool(m["hidden"])
    finally:
        con.close()
    return {"ok": True, "manage_token": manage, "profile": prof, "hidden": hidden}


def _owned(con: sqlite3.Connection, handle: str, token: Optional[str]) -> sqlite3.Row:
    h = _handle(handle)
    row = con.execute("SELECT * FROM mistresses WHERE handle_lc=?", (h.lower(),)).fetchone()
    if not row or not token or not hmac.compare_digest(row["manage_hash"], _h(token)):
        raise HTTPException(403, "Token di gestione non valido.")
    return row


@router.put("/mistress/{handle}")
def update_mistress(handle: str, body: MistressIn, request: Request, x_manage_token: Optional[str] = Header(None)):
    _limit(request, "mupd", 20, 3600, gap=2)
    f = _check_fields(body)
    con = _connect()
    try:
        row = _owned(con, handle, x_manage_token)
        con.execute(
            "UPDATE mistresses SET display_name=?, gender=?, bio=?, tags=?, avatar=?, updated_at=? WHERE handle_lc=?",
            (f["display_name"], f["gender"], f["bio"], f["tags"], f["avatar"], _now(), row["handle_lc"]),
        )
        con.commit()
        m = con.execute("SELECT * FROM mistresses WHERE handle_lc=?", (row["handle_lc"],)).fetchone()
        return {"ok": True, "profile": _profile(m, con, full=True)}
    finally:
        con.close()


@router.delete("/mistress/{handle}")
def delete_mistress(handle: str, request: Request, x_manage_token: Optional[str] = Header(None)):
    _limit(request, "mdel", 20, 3600)
    con = _connect()
    try:
        row = _owned(con, handle, x_manage_token)
        con.execute("DELETE FROM fedeli WHERE mistress_lc=?", (row["handle_lc"],))
        con.execute("DELETE FROM mistresses WHERE handle_lc=?", (row["handle_lc"],))
        con.commit()
    finally:
        con.close()
    return {"ok": True, "deleted": True}


@router.get("/mistresses")
def list_mistresses(request: Request, page: int = 1, per: int = 12):
    _limit(request, "read", 240, 60)
    per = max(1, min(PER_PAGE_MAX, per))
    page = max(1, min(10_000, page))
    con = _connect()
    try:
        total = con.execute("SELECT COUNT(*) FROM mistresses WHERE hidden=0").fetchone()[0]
        rows = con.execute(
            "SELECT * FROM mistresses WHERE hidden=0 ORDER BY created_at DESC, handle_lc LIMIT ? OFFSET ?",
            (per, (page - 1) * per),
        ).fetchall()
        items = [_profile(r, con) for r in rows]
    finally:
        con.close()
    return {"items": items, "total": total, "page": page, "per": per, "pages": max(1, (total + per - 1) // per)}


@router.get("/mistress/{handle}")
def get_mistress(handle: str, request: Request):
    _limit(request, "read", 240, 60)
    h = _handle(handle)
    con = _connect()
    try:
        row = con.execute("SELECT * FROM mistresses WHERE handle_lc=? AND hidden=0", (h.lower(),)).fetchone()
        if not row:
            raise HTTPException(404, "Mistress non trovata.")
        return _profile(row, con, full=True)
    finally:
        con.close()


# ---------------------------------------------------------------- Fedeli
@router.post("/fedele")
def add_fedele(body: FedeleIn, request: Request):
    _limit(request, "fedele", 10, 3600, gap=3)
    if not body.adult:
        raise HTTPException(400, "Devi confermare di avere 18 anni o più.")
    mh = _handle(body.mistress)
    nick = _text(body.nick, 24, "Nickname", required=True)
    if len(nick) < 2 or not re.fullmatch(r"[\w .\-]+", nick, re.UNICODE):
        raise HTTPException(400, "Nickname: 2-24 caratteri, lettere, numeri, spazio, punto, trattino.")
    xh = None
    if body.x_handle and body.x_handle.strip().lstrip("@"):
        xh = _handle(body.x_handle)
    con = _connect()
    try:
        if not con.execute("SELECT 1 FROM mistresses WHERE handle_lc=? AND hidden=0", (mh.lower(),)).fetchone():
            raise HTTPException(404, "Mistress non trovata.")
        tok = secrets.token_urlsafe(24)
        try:
            cur = con.execute(
                "INSERT INTO fedeli(mistress_lc, nick, nick_lc, x_handle, public, created_at, delete_hash) VALUES(?,?,?,?,?,?,?)",
                (mh.lower(), nick, nick.lower(), xh, 1 if body.public else 0, _now(), _h(tok)),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Questo nickname è già Fedele di questa Mistress. Scegline un altro.")
        con.commit()
        fid = cur.lastrowid
        n = con.execute("SELECT COUNT(*) FROM fedeli WHERE mistress_lc=?", (mh.lower(),)).fetchone()[0]
    finally:
        con.close()
    return {"ok": True, "id": fid, "delete_token": tok, "mistress": mh.lower(), "fedeli_count": n}


@router.delete("/fedele/{fid}")
def del_fedele(fid: int, request: Request, x_delete_token: Optional[str] = Header(None)):
    _limit(request, "fdel", 30, 3600)
    con = _connect()
    try:
        row = con.execute("SELECT * FROM fedeli WHERE id=?", (fid,)).fetchone()
        if not row or not x_delete_token or not hmac.compare_digest(row["delete_hash"], _h(x_delete_token)):
            raise HTTPException(403, "Token non valido.")
        con.execute("DELETE FROM fedeli WHERE id=?", (fid,))
        con.commit()
    finally:
        con.close()
    return {"ok": True, "deleted": True}


# ---------------------------------------------------------------- Segnala
@router.post("/report")
def report(body: ReportIn, request: Request):
    _limit(request, "report", 10, 3600, gap=5)
    kind = body.kind if body.kind in ("mistress", "fedele") else None
    if not kind:
        raise HTTPException(400, "Tipo non valido.")
    target = _handle(body.target) if kind == "mistress" else str(int(body.target)) if str(body.target).isdigit() else None
    if not target:
        raise HTTPException(400, "Obiettivo non valido.")
    reason = unicodedata.normalize("NFC", body.reason or "")
    reason = "".join(ch for ch in reason if unicodedata.category(ch)[0] != "C").strip()[:300]
    con = _connect()
    try:
        con.execute("INSERT INTO reports(kind, target, reason, created_at) VALUES(?,?,?,?)", (kind, target, reason, _now()))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


# ---------------------------------------------------------------- Admin
def _admin(key: Optional[str]) -> None:
    want_hash = os.environ.get("VH_ADMIN_KEY_SHA256", "").strip().lower()
    want_plain = os.environ.get("VH_ADMIN_KEY", "")
    if not want_hash and not want_plain:
        raise HTTPException(503, "Admin non configurato (VH_ADMIN_KEY_SHA256).")
    if not key:
        raise HTTPException(401, "Chiave admin mancante.")
    ok = False
    if want_hash:
        ok = hmac.compare_digest(_h(key), want_hash)
    if not ok and want_plain:
        ok = hmac.compare_digest(key.encode(), want_plain.encode())
    if not ok:
        time.sleep(1)
        raise HTTPException(403, "Chiave admin errata.")


@router.get("/admin/reports")
def admin_reports(request: Request, x_admin_key: Optional[str] = Header(None), all: int = 0):
    _limit(request, "admin", 60, 3600)
    _admin(x_admin_key)
    con = _connect()
    try:
        q = "SELECT * FROM reports" + ("" if all else " WHERE done=0") + " ORDER BY created_at DESC LIMIT 200"
        return {"items": [dict(r) for r in con.execute(q).fetchall()]}
    finally:
        con.close()


@router.get("/admin/mistresses")
def admin_mistresses(request: Request, x_admin_key: Optional[str] = Header(None)):
    _limit(request, "admin", 60, 3600)
    _admin(x_admin_key)
    con = _connect()
    try:
        rows = con.execute("SELECT * FROM mistresses ORDER BY created_at DESC LIMIT 500").fetchall()
        return {"items": [dict(_profile(r, con), hidden=bool(r["hidden"])) for r in rows]}
    finally:
        con.close()


@router.delete("/admin/mistress/{handle}")
def admin_hide(handle: str, request: Request, x_admin_key: Optional[str] = Header(None)):
    _limit(request, "admin", 60, 3600)
    _admin(x_admin_key)
    h = _handle(handle)
    con = _connect()
    try:
        n = con.execute("UPDATE mistresses SET hidden=1 WHERE handle_lc=?", (h.lower(),)).rowcount
        con.execute("UPDATE reports SET done=1 WHERE kind='mistress' AND lower(target)=?", (h.lower(),))
        con.commit()
    finally:
        con.close()
    if not n:
        raise HTTPException(404, "Mistress non trovata.")
    return {"ok": True, "hidden": True}


@router.post("/admin/mistress/{handle}/unhide")
def admin_unhide(handle: str, request: Request, x_admin_key: Optional[str] = Header(None)):
    _limit(request, "admin", 60, 3600)
    _admin(x_admin_key)
    h = _handle(handle)
    con = _connect()
    try:
        n = con.execute("UPDATE mistresses SET hidden=0 WHERE handle_lc=?", (h.lower(),)).rowcount
        con.commit()
    finally:
        con.close()
    if not n:
        raise HTTPException(404, "Mistress non trovata.")
    return {"ok": True, "hidden": False}


@router.get("/admin/fedeli")
def admin_fedeli(request: Request, mistress: str, x_admin_key: Optional[str] = Header(None)):
    _limit(request, "admin", 60, 3600)
    _admin(x_admin_key)
    h = _handle(mistress)
    con = _connect()
    try:
        rows = con.execute(
            "SELECT id, nick, x_handle, public, created_at FROM fedeli WHERE mistress_lc=? ORDER BY created_at DESC",
            (h.lower(),),
        ).fetchall()
        return {"items": [dict(r) for r in rows]}
    finally:
        con.close()


@router.delete("/admin/fedele/{fid}")
def admin_del_fedele(fid: int, request: Request, x_admin_key: Optional[str] = Header(None)):
    _limit(request, "admin", 60, 3600)
    _admin(x_admin_key)
    con = _connect()
    try:
        n = con.execute("DELETE FROM fedeli WHERE id=?", (fid,)).rowcount
        con.execute("UPDATE reports SET done=1 WHERE kind='fedele' AND target=?", (str(fid),))
        con.commit()
    finally:
        con.close()
    if not n:
        raise HTTPException(404, "Fedele non trovato.")
    return {"ok": True, "deleted": True}


@router.get("/status")
def status():
    con = _connect()
    try:
        n = con.execute("SELECT COUNT(*) FROM mistresses WHERE hidden=0").fetchone()[0]
    finally:
        con.close()
    return {"ok": True, "mistresses": n}
