'use strict';
// Socket di amministrazione locale (Unix, 0600, in STATE_DIR): SOLO per scripts/apply.js lanciato da root sul VPS.
// Non è una porta TCP, quindi nginx non la può esporre. Una richiesta = una riga JSON, una risposta = una riga JSON.
// © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
const net = require('net');
const fs = require('fs');

function makeAdminServer(handle) {
  return net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (d) => {
      buf += d;
      if (buf.length > 4096) { sock.end(JSON.stringify({ ok: false, error: 'richiesta troppo grande' }) + '\n'); return; }
      const nl = buf.indexOf('\n'); if (nl < 0) return;
      let req; try { req = JSON.parse(buf.slice(0, nl)); } catch (_) { sock.end(JSON.stringify({ ok: false, error: 'JSON non valido' }) + '\n'); return; }
      buf = '';
      try { sock.end(JSON.stringify(await handle(req)) + '\n'); } catch (e) { sock.end(JSON.stringify({ ok: false, error: e.message }) + '\n'); }
    });
    sock.on('error', () => {});
  });
}

function listenAdmin(server, sockPath, cb) {
  try { fs.unlinkSync(sockPath); } catch (_) { /* non c'era */ }
  const old = process.umask(0o177);
  server.listen(sockPath, () => { process.umask(old); try { fs.chmodSync(sockPath, 0o600); } catch (_) { /* */ } if (cb) cb(); });
  return server;
}

// Client usato da scripts/apply.js.
function request(sockPath, req, timeoutMs = 15 * 60000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath); let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeoutMs);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
    s.on('data', (d) => { buf += d; });
    s.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('risposta non valida')); } });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

module.exports = { makeAdminServer, listenAdmin, request };
