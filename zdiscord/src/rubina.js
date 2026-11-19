'use strict';
// Rubina nel bot: risponde solo nei canali 18+ (nsfw) della 18+ ROOM / Velvet Club e solo a chi ha "Verificato 18+".
// Usa /api/rubina/chat di OurVelvet con mode "discord" (flirt e conversazione, niente contenuti espliciti).
// Le conversazioni stanno solo in memoria (30 min), non vengono salvate né scritte nei log. ROSSO ferma e silenzia.
const crypto = require('crypto');
const SAFE_RE = /\brosso\b/i;
const SAFEWORD_REPLY = 'ROSSO ricevuto. Mi fermo subito ed esco dal ruolo. 🖤 Come stai? Prenditi un momento. Per 60 minuti non ti scrivo più; se vuoi riprendere prima, usa `/rubina riprendi:True`.';
const NEUTRAL = 'Rubina risponde solo nei canali 18+ della **18+ ROOM** e del **Velvet Club**, e solo a chi ha il ruolo **Verificato 18+** (lo ottieni in #ingresso-18). Per info sul club usa /velvet.';

function makeRubina({ post, now = () => Date.now(), gapMs = 20000, perHour = 15, silenceMs = 60 * 60000, ttlMs = 30 * 60000 } = {}) {
  const sess = new Map(); // userId -> { msgs, at, silentUntil, hits: [] }
  const get = (u) => { let s = sess.get(u); if (!s) { s = { msgs: [], at: 0, silentUntil: 0, hits: [] }; sess.set(u, s); } return s; };
  function sweep() { const t = now(); for (const [k, s] of sess) if (t - s.at > ttlMs && s.silentUntil < t) sess.delete(k); }
  async function talk({ userId, text, allowed, resume }) {
    sweep();
    const s = get(userId); const t = now();
    if (!allowed) return { ephemeral: true, content: NEUTRAL };
    if (resume) { s.silentUntil = 0; s.msgs = []; if (!text) return { ephemeral: true, content: 'Pausa finita. Quando vuoi, scrivimi con /rubina.' }; }
    text = String(text || '').trim().slice(0, 1000);
    if (!text) return { ephemeral: true, content: 'Scrivi qualcosa.' };
    if (SAFE_RE.test(text)) { s.msgs = []; s.silentUntil = t + silenceMs; s.at = t; return { ephemeral: true, content: SAFEWORD_REPLY, safeword: true }; }
    if (s.silentUntil > t) return { ephemeral: true, content: 'Sei in pausa dopo ROSSO: Rubina riprende tra ' + Math.ceil((s.silentUntil - t) / 60000) + ' minuti, oppure usa `/rubina riprendi:True`.' };
    s.hits = s.hits.filter((x) => t - x < 3600000);
    if (s.hits.length && t - s.hits[s.hits.length - 1] < gapMs) return { ephemeral: true, content: 'Piano. Un messaggio ogni ' + Math.round(gapMs / 1000) + ' secondi.' };
    if (s.hits.length >= perHour) return { ephemeral: true, content: 'Basta per quest\'ora. Torna più tardi.' };
    s.hits.push(t); s.at = t;
    const msgs = [...s.msgs, { role: 'user', content: text }].slice(-20);
    const key = 'dc-' + crypto.createHash('sha256').update('zdiscord:' + userId).digest('hex').slice(0, 16);
    const r = await post({ messages: msgs, mode: 'discord' }, key);
    if (r.status === 503) return { ephemeral: true, content: 'Rubina sta già rispondendo a qualcuno. Riprova tra poco.' };
    if (r.status === 429) return { ephemeral: true, content: (r.json && r.json.detail) || 'Troppi messaggi, riprova più tardi.' };
    if (r.status !== 200 || !r.json || !r.json.reply) return { ephemeral: true, content: 'Rubina non risponde ora. Riprova tra poco.' };
    if (r.json.safeword) { s.msgs = []; s.silentUntil = t + silenceMs; return { ephemeral: true, content: SAFEWORD_REPLY, safeword: true }; }
    s.msgs = [...msgs, { role: 'assistant', content: r.json.reply }].slice(-20);
    const quote = text.length > 300 ? text.slice(0, 299) + '…' : text;
    return { content: '> ' + quote.replace(/\n/g, '\n> ') + '\n**Rubina:** ' + String(r.json.reply).slice(0, 1500) + '\n-# IA che interpreta Rubina · 18+ · ROSSO la ferma' };
  }
  return { talk, size: () => sess.size };
}

function httpPost(baseUrl) {
  return async (body, key) => {
    const r = await fetch(baseUrl + '/api/rubina/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(130000) });
    let json = null; try { json = await r.json(); } catch (_) { /* */ }
    return { status: r.status, json };
  };
}

module.exports = { makeRubina, httpPost, NEUTRAL, SAFEWORD_REPLY };
