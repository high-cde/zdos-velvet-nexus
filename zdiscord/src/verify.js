'use strict';
// Verifica holder: nonce monouso legato a (server, utente Discord), messaggio firmato con Phantom signMessage,
// controllo ed25519 lato server. Nessuna transazione, nessun accesso ai fondi. Il wallet non viene salvato.
const crypto = require('crypto');
const b58 = require('./base58');

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function makeNonceStore({ ttlMs = 600000, now = () => Date.now(), max = 5000 } = {}) {
  const m = new Map();
  function sweep() { const t = now(); for (const [k, v] of m) if (v.exp <= t) m.delete(k); }
  return {
    create(guildId, userId) {
      sweep();
      if (m.size >= max) throw new Error('troppe verifiche in corso, riprova tra poco');
      const nonce = crypto.randomBytes(18).toString('base64url');
      const rec = { nonce, guildId: String(guildId), userId: String(userId), exp: now() + ttlMs };
      m.set(nonce, rec);
      return rec;
    },
    peek(nonce) { const r = m.get(String(nonce || '')); if (!r) return null; if (r.exp <= now()) { m.delete(r.nonce); return null; } return r; },
    consume(nonce) { const r = this.peek(nonce); if (r) m.delete(r.nonce); return r; },
    size() { return m.size; },
  };
}

function messageFor(rec) {
  return [
    'z-xSOLANA · verifica holder Discord',
    'Utente Discord: ' + rec.userId,
    'Server: ' + rec.guildId,
    'Nonce: ' + rec.nonce,
    'Scadenza: ' + new Date(rec.exp).toISOString(),
    'Firmando non invii transazioni e non dai accesso ai fondi.',
  ].join('\n');
}

function verifyEd25519(publicKeyB58, message, signatureB58) {
  if (!MINT_RE.test(String(publicKeyB58 || ''))) return false;
  let pk, sig;
  try { pk = b58.decode(publicKeyB58); sig = b58.decode(signatureB58); } catch (_) { return false; }
  if (pk.length !== 32 || sig.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pk.toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch (_) { return false; }
}

// Esegue tutta la verifica. deps: { store, tokenBalance(owner,mint), assignRoles({guildId,userId,dsn,velvet}), mints:{dsn,velvet} }
async function handleVerify(body, deps) {
  const { nonce, publicKey, signature } = body || {};
  const rec = deps.store.peek(nonce);
  if (!rec) return { status: 400, json: { ok: false, error: 'Link scaduto o già usato: rilancia /verifica su Discord.' } };
  if (!verifyEd25519(publicKey, messageFor(rec), signature)) return { status: 400, json: { ok: false, error: 'Firma non valida.' } };
  deps.store.consume(nonce);
  let dsn = 0n, velvet = 0n;
  try {
    [dsn, velvet] = await Promise.all([deps.tokenBalance(publicKey, deps.mints.dsn), deps.tokenBalance(publicKey, deps.mints.velvet)]);
  } catch (e) { return { status: 502, json: { ok: false, error: 'Non riesco a leggere i saldi su Solana, riprova tra poco.' } }; }
  const roles = await deps.assignRoles({ guildId: rec.guildId, userId: rec.userId, dsn: dsn > 0n, velvet: velvet > 0n });
  return { status: 200, json: { ok: true, holder: { dsn: dsn > 0n, velvet: velvet > 0n }, roles } };
}

module.exports = { makeNonceStore, messageFor, verifyEd25519, handleVerify };
