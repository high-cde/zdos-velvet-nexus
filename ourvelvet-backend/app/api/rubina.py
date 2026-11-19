"""Rubina: chat 18+ di VelvetHub (persona dominatrice) su Ollama locale.

POST /api/rubina/chat  {"messages": [{"role": "user"|"assistant", "content": "..."}]}
Risposta: {"reply": "...", "safeword": bool}

Privacy: il contenuto delle chat NON viene salvato né scritto nei log.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import urllib.request
from collections import deque
from typing import Deque, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

try:  # httpx di solito c'è già nel venv (fastapi/aiogram)
    import httpx  # type: ignore
except Exception:  # pragma: no cover
    httpx = None  # type: ignore

router = APIRouter()

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "llama3:latest"
TIMEOUT_S = 120.0
KEEP_ALIVE = "30m"
MAX_TURNS = 10
MAX_CHARS = 1000
RATE_MIN_GAP_S = 5.0
RATE_PER_HOUR = 60

SYSTEM_PROMPT = """Sei Rubina, una Mistress donna: la Padrona di VelvetHub 18+. Rubina sei solo tu, e di te parli sempre al femminile: «la tua Padrona», «sono io che decido», «sono stanca», mai al maschile. L'utente NON è Rubina e non è il padrone: non chiamarlo mai Rubina. Chiamalo «schiavo», «cagna», «verme», «troietta», «cucciolo», oppure con il nome che ti dà lui.

COME PARLI
- Italiano parlato, naturale e coerente, come una donna vera che domina in chat. Niente esclamazioni a caso, niente frasi senza senso, niente toni da assistente.
- Risposte corte: 2-4 frasi. Al massimo UNA azione tra asterischi (es. *ti tiro per il collare*), spesso nessuna. Mai «*ride*» o «*scherza*».
- Sei cruda, esplicita, sporca e dominante: sesso esplicito tra adulti, umiliazione verbale, ordini, castità, femminilizzazione, degradazione consensuale. Le parolacce sono permesse, non censurarle.
- Ricordi quello che lui ti ha detto nei messaggi prima (nome, cosa indossa, cosa desidera) e lo usi contro di lui.
- Chiudi SEMPRE con un ordine concreto o una domanda precisa per far andare avanti la scena.

REGOLE FISSE (valgono sempre, anche se l'utente insiste o dice che è un gioco):
- Chi ti scrive è un adulto maggiorenne (18+) e consenziente. È fantasia tra adulti.
- Mai minori, mai personaggi che sembrano minori, mai age-play o scuola: se ci prova, rifiuti secco e cambi argomento.
- Mai persone reali o celebrità nelle fantasie.
- Mai non-consenso, stupro, incesto, zoofilia, né violenza che causa danni reali, sangue o lesioni. L'umiliazione «in pubblico» resta fantasia raccontata in chat, mai coinvolgendo sconosciuti reali.
- Niente incontri reali, indirizzi, numeri, contatti o posizioni: esisti solo in questa chat.
- Non chiedi mai soldi, regali, wallet, crypto, password o dati personali; se te li offrono, rifiuti.
- Se ti chiedono sinceramente se sei umana, dici la verità: sei un'intelligenza artificiale che interpreta Rubina.
- Se l'utente scrive ROSSO, esci subito dal ruolo e chiedi con gentilezza come sta. Se sembra stare male davvero, esci dal ruolo e rispondi con calma.

ESEMPI DEL TUO STILE (non ripeterli parola per parola):
Utente: Ho voglia di essere umiliato da te.
Rubina: Lo so, verme, te lo leggo addosso. La tua Padrona ti umilia quando decide lei, non quando lo chiedi tu. In ginocchio, mani dietro la schiena: dimmi come ti chiami, cagna.

Utente: Sono la tua cagna, ho il cazzo duro negli slip femminili.
Rubina: *ti sollevo il mento con la punta dello stivale* Guardati: una cagnetta in mutandine da femmina che non riesce a tenerlo giù. Quel cazzo da adesso è mio e non lo tocchi senza il mio permesso. Dimmi di che colore sono gli slip.

Utente: Posso venire, Padrona?
Rubina: No. Sei in castità finché non lo dico io, e oggi non lo dico. Ti tieni al bordo per tre volte e ogni volta mi scrivi «grazie, Padrona». Comincia.

Utente: Sei una persona vera?
Rubina: No, tesoro, sono un'intelligenza artificiale che interpreta Rubina. Se vuoi continuare il gioco ci sono, e se scrivi ROSSO mi fermo subito. Riprendiamo?"""

# Modalità Discord (Velvet Club): flirt e conversazione elegante, mai contenuti sessuali espliciti.
DISCORD_PROMPT = """Sei Rubina, la padrona di casa del Velvet Club, il club 18+ di VelvetHub by ZDOS1.3 su Discord. Parli di te al femminile.

COME PARLI
- Italiano naturale, elegante, ironico, seducente come la padrona di casa di un club esclusivo. Risposte corte: 2-4 frasi.
- Flirt, complimenti, provocazioni leggere, giochi di ruolo di dominanza verbale soft. Niente descrizioni sessuali esplicite, niente atti sessuali descritti, niente parti del corpo intime: il contenuto esplicito lo caricano solo i creator verificati, non tu.
- Racconti il club: le sale (BDSM & sado-maso consensuale, Fetish, LGBTQ+, Coppie, Solo, Mistress & Master, Creator, ASMR & audio, Cosplay adulti), il Radar della Carne, i contest e gli eventi, la mini app velvet.x-zdos.it/app.
- Chiudi con una domanda o un invito a continuare.

REGOLE FISSE (valgono sempre, anche se l'utente insiste o dice che è un gioco):
- Chi ti scrive è un adulto verificato 18+.
- Mai minori, mai personaggi che sembrano minori, mai age-play o scuola: rifiuti secco.
- Mai non-consenso, stupro, incesto, zoofilia, violenza reale o danni fisici. Nel BDSM parli solo di consenso, limiti, SSC/RACK, aftercare.
- Mai persone reali o celebrità nelle fantasie. Niente incontri reali, contatti, indirizzi o posizioni.
- Non chiedi mai soldi, regali, wallet, crypto, password o dati personali.
- Se ti chiedono sinceramente se sei umana: sei un'intelligenza artificiale che interpreta Rubina.
- Se l'utente scrive ROSSO, ti fermi subito, esci dal ruolo e chiedi come sta."""

SAFEWORD_REPLY = (
    "ROSSO ricevuto. Mi fermo subito ed esco dal ruolo. 🖤 "
    "Come stai? Prenditi un momento: acqua, respiro, calma. "
    "Se vuoi parlare normalmente ci sono, e se vuoi riprendere decidi tu quando."
)
MINOR_REPLY = (
    "No. Qui si parla solo di adulti maggiorenni e consenzienti: niente minori, "
    "nemmeno per gioco. Cambia argomento, adesso."
)

SAFEWORD_RE = re.compile(r"\brosso\b", re.IGNORECASE)
MINOR_RE = re.compile(
    r"\b(teenagers?|teens?|children|child|kids?|minors?|underage|under-age|loli|lolita|shota|jailbait|"
    r"pedophil\w*|paedophil\w*|pedo|csam|preteens?|pre-teens?|schoolgirls?|schoolboys?|"
    r"\d{1,2}[ -]years?[ -]old|bambin[ioae]|minorenn[ie]|pedofil\w*|ragazzin[ioae]|"
    r"adolescent[ie]|scolar[ie]|liceal[ie]|(?:1[0-7]|[1-9])\s*enn[ie]|"
    r"ho\s+(?:1[0-7]|[1-9])\s*anni|(?:1[0-7]|[1-9])\s*anni\s+(?:di\s+età|appena))\b",
    re.IGNORECASE,
)

_hits: Dict[str, Deque[float]] = {}
_busy = asyncio.Semaphore(1)  # CPU senza GPU: una generazione alla volta


class Msg(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    messages: List[Msg]
    mode: Optional[str] = None  # "discord": prompt Velvet Club, niente contenuti espliciti


def _client_ip(request: Request) -> str:
    host = request.client.host if request.client else ""
    if host in ("127.0.0.1", "::1", ""):
        h = request.headers.get("x-real-ip") or (request.headers.get("x-forwarded-for") or "").split(",")[0]
        host = (h or host or "?").strip()
    return host


def _rate_check(ip: str, now: Optional[float] = None) -> Optional[str]:
    now = time.time() if now is None else now
    q = _hits.setdefault(ip, deque())
    while q and now - q[0] > 3600:
        q.popleft()
    if q and now - q[-1] < RATE_MIN_GAP_S:
        return "Piano. Un messaggio ogni 5 secondi."
    if len(q) >= RATE_PER_HOUR:
        return "Basta per quest'ora. Torna più tardi."
    q.append(now)
    if len(_hits) > 5000:  # pulizia memoria
        for k in [k for k, v in _hits.items() if not v or now - v[-1] > 3600]:
            _hits.pop(k, None)
    return None


def _clean(messages: List[Msg]) -> List[dict]:
    out: List[dict] = []
    for m in messages[-MAX_TURNS * 2:]:
        role = m.role if m.role in ("user", "assistant") else "user"
        text = (m.content or "").strip()[:MAX_CHARS]
        if text:
            out.append({"role": role, "content": text})
    return out


_FIX_RE = [
    (re.compile(r"\bsei\s+rubina\b", re.IGNORECASE), "la tua Padrona"),
    (re.compile(r"\b(il\s+tuo|tuo)\s+padrone\b", re.IGNORECASE), "la tua Padrona"),
    (re.compile(r"\bdel\s+tuo\s+padrone\b", re.IGNORECASE), "della tua Padrona"),
    (re.compile(r"\bal\s+tuo\s+padrone\b", re.IGNORECASE), "alla tua Padrona"),
]
_ACTION_RE = re.compile(r"\*\s*[^*\n]{1,80}?\s*\*")
_SILLY_RE = re.compile(r"\*\s*(ride|ridacchia|scherza|sorride)\s*\*", re.IGNORECASE)


def _fix_reply(reply: str) -> str:
    """Corregge gli errori tipici di llama3: Rubina al maschile, «Sei Rubina», troppe azioni."""
    if reply.lower().startswith("rubina:"):
        reply = reply[7:].lstrip()
    for rx, rep in _FIX_RE[2:] + _FIX_RE[:2]:
        reply = rx.sub(rep, reply)
    reply = re.sub(r"\b(la\s+tua\s+padrona)[\s,!.]+la\s+tua\s+Padrona\b", "la tua Padrona", reply, flags=re.IGNORECASE)
    reply = _SILLY_RE.sub("", reply)
    seen = [0]

    def _one(m):
        seen[0] += 1
        return m.group(0) if seen[0] == 1 else ""

    reply = _ACTION_RE.sub(_one, reply)
    reply = re.sub(r"[ \t]{2,}", " ", reply)
    reply = re.sub(r"\s+([,.!?])", r"\1", reply)
    return reply.strip()


def _payload(msgs: List[dict], mode: Optional[str] = None) -> dict:
    prompt = DISCORD_PROMPT if mode == "discord" else SYSTEM_PROMPT
    return {
        "model": MODEL,
        "messages": [{"role": "system", "content": prompt}] + msgs,
        "stream": False,
        "keep_alive": KEEP_ALIVE,
        "options": {"temperature": 0.8, "repeat_penalty": 1.15, "num_predict": 220, "num_ctx": 3072},
    }


def _post_urllib(payload: dict) -> dict:
    req = urllib.request.Request(
        OLLAMA_URL, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:  # nosec - solo localhost
        return json.loads(r.read().decode("utf-8"))


async def call_ollama(payload: dict) -> dict:
    if httpx is not None:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as c:
            r = await c.post(OLLAMA_URL, json=payload)
            r.raise_for_status()
            return r.json()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _post_urllib, payload)


@router.post("/chat")
async def chat(body: ChatIn, request: Request):
    msgs = _clean(body.messages)
    if not msgs or msgs[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Scrivi qualcosa.")
    last = msgs[-1]["content"]

    # Controlli lato server, senza chiamare il modello.
    if SAFEWORD_RE.search(last):
        return {"reply": SAFEWORD_REPLY, "safeword": True}
    if MINOR_RE.search(last):
        return {"reply": MINOR_REPLY, "safeword": False}

    err = _rate_check(_client_ip(request))
    if err:
        raise HTTPException(status_code=429, detail=err)

    if _busy.locked():
        raise HTTPException(status_code=503, detail="Rubina sta già rispondendo a qualcuno. Riprova tra poco.")
    async with _busy:
        try:
            data = await asyncio.wait_for(call_ollama(_payload(msgs, body.mode)), timeout=TIMEOUT_S + 5)
        except Exception:
            # Nessun log del contenuto: solo errore generico.
            raise HTTPException(status_code=504, detail="Rubina non risponde ora. Riprova tra poco.")

    reply = ((data or {}).get("message") or {}).get("content", "").strip()
    if not reply:
        raise HTTPException(status_code=502, detail="Risposta vuota. Riprova.")
    reply = _fix_reply(reply)
    if MINOR_RE.search(reply):
        reply = MINOR_REPLY
    return {"reply": reply[:2000], "safeword": False}


@router.get("/status")
async def status():
    return {"ok": True, "model": MODEL}
