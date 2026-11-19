'use strict';
// Accesso in sola lettura a Solana e RugCheck. Nessuna chiave, nessuna transazione.
function makeSolana({ rpcUrls, fetchImpl = fetch, timeoutMs = 12000 }) {
  async function rpc(method, params) {
    let err;
    for (const url of rpcUrls) {
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        const j = await r.json();
        if (j.error) { err = new Error(j.error.message || 'errore RPC'); continue; }
        return j.result;
      } catch (e) { err = e; }
    }
    throw err || new Error('RPC non raggiungibile');
  }
  async function fetchJson(url) {
    const r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  // Saldo (unità base, BigInt) di un mint per un owner, su tutti i suoi token account.
  async function tokenBalance(owner, mint) {
    const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
    let total = 0n;
    for (const a of (r && r.value) || []) {
      const amt = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info && a.account.data.parsed.info.tokenAmount;
      if (amt && amt.amount) total += BigInt(amt.amount);
    }
    return total;
  }
  return { rpc, fetchJson, tokenBalance };
}
module.exports = { makeSolana };
