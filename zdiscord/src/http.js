'use strict';
// API di verifica su 127.0.0.1 (nginx: location /discord/api/ di x-zdos.it). Solo JSON, nessun file statico.
const http = require('http');
const { messageFor, handleVerify } = require('./verify');

function makeServer(deps) {
  const hits = new Map(); // limite semplice per IP: 30 richieste/minuto
  function limited(ip) {
    const t = Date.now(); const h = (hits.get(ip) || []).filter((x) => t - x < 60000); h.push(t); hits.set(ip, h);
    if (hits.size > 10000) hits.clear();
    return h.length > 30;
  }
  function send(res, status, json) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(json));
  }
  return http.createServer(async (req, res) => {
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    if (limited(ip)) return send(res, 429, { ok: false, error: 'Troppe richieste, riprova tra un minuto.' });
    const url = new URL(req.url, 'http://local');
    const p = url.pathname.replace(/^\/discord\/api/, '');
    try {
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, discord: deps.discordReady(), ...(deps.relayStatus ? { relay: deps.relayStatus() } : {}) });
      if (req.method === 'GET' && p === '/message') {
        const rec = deps.store.peek(url.searchParams.get('n'));
        if (!rec) return send(res, 404, { ok: false, error: 'Link scaduto o già usato: rilancia /verifica su Discord.' });
        return send(res, 200, { ok: true, message: messageFor(rec), expiresAt: new Date(rec.exp).toISOString() });
      }
      if (req.method === 'POST' && p === '/verify') {
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 4096) return send(res, 413, { ok: false, error: 'richiesta troppo grande' }); }
        let body; try { body = JSON.parse(raw); } catch (_) { return send(res, 400, { ok: false, error: 'JSON non valido' }); }
        const r = await handleVerify(body, deps);
        return send(res, r.status, r.json);
      }
      return send(res, 404, { ok: false, error: 'non trovato' });
    } catch (e) {
      console.error('http', e.message);
      return send(res, 500, { ok: false, error: 'errore interno' });
    }
  });
}
module.exports = { makeServer };
