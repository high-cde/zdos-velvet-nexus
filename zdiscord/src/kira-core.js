/*! K.I.R.A. core · zRoute + bot Discord z-xSOLANA · © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
 * Controlli reali su un mint Solana, senza chiavi e senza firme:
 *  - RPC getAccountInfo (jsonParsed): programma, mint/freeze authority, supply, estensioni Token-2022;
 *  - holder principali: RPC getTokenLargestAccounts, se l'endpoint lo consente, altrimenti RugCheck (api.rugcheck.xyz);
 *  - RugCheck: rischi segnalati, token "rugged", LP/AMM conosciuti (per non contare le pool come holder).
 * Le pool/AMM vengono escluse dal calcolo della concentrazione, ma sono mostrate.
 * Stato dei controlli: ok · info · warn · fail · nd (non disponibile). fail = zRoute blocca l'acquisto.
 * Funziona sia nel browser (window.KiraCore) sia in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KiraCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const TOKEN_V1 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const WSOL = 'So11111111111111111111111111111111111111112';
  // Emittenti centralizzati noti: authority attive per scelta dichiarata dell'emittente (non è un rug pull, ma possono congelare).
  const KNOWN_ISSUERS = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'Circle (USDC)',
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'Tether (USDT)',
  };
  const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const RUGCHECK = 'https://api.rugcheck.xyz/v1/tokens/';

  function check(id, label, status, detail) { return { id, label, status, detail }; }
  function mask(a) { a = String(a || ''); return a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : a; }
  function isMint(s) { return MINT_RE.test(String(s || '').trim()); }
  function pct(n) { return (Math.round(n * 100) / 100).toLocaleString('it-IT') + '%'; }

  // rpc(method, params) -> result ; fetchJson(url) -> json
  async function kiraReport(mint, opts) {
    opts = opts || {};
    const rpc = opts.rpc; const fetchJson = opts.fetchJson;
    mint = String(mint || '').trim();
    const out = { mint, verdict: 'N/D', fails: 0, warns: 0, checks: [], decimals: null, symbol: null, name: null, program: null, sources: [] };
    if (!isMint(mint)) { out.checks.push(check('input', 'Indirizzo', 'fail', 'non è un indirizzo Solana valido')); out.fails = 1; out.verdict = 'BLOCCATO'; return out; }

    // 1) on-chain
    let info = null;
    try { info = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]); out.sources.push('rpc'); }
    catch (e) { out.checks.push(check('rpc', 'RPC Solana', 'nd', 'RPC non raggiungibile: ' + e.message)); }
    let supplyRaw = null;
    if (info) {
      if (!info.value) { out.checks.push(check('acct', 'Account', 'fail', 'mint non trovato su mainnet')); }
      else {
        const v = info.value; const parsed = v.data && v.data.parsed;
        out.program = v.owner === TOKEN_2022 ? 'Token-2022' : v.owner === TOKEN_V1 ? 'SPL Token' : 'altro';
        if (!parsed || parsed.type !== 'mint') out.checks.push(check('acct', 'Account', 'fail', 'non è un mint SPL (' + out.program + ')'));
        else {
          const p = parsed.info; const issuer = KNOWN_ISSUERS[mint];
          out.decimals = p.decimals; supplyRaw = Number(p.supply);
          out.checks.push(check('prog', 'Programma token', 'ok', out.program));
          if (p.mintAuthority == null) out.checks.push(check('mint', 'Mint authority', 'ok', 'revocata: nessuno può stampare altri token'));
          else out.checks.push(check('mint', 'Mint authority', issuer ? 'info' : 'fail', issuer ? 'attiva, gestita da ' + issuer : 'ATTIVA: qualcuno può stampare altri token'));
          if (p.freezeAuthority == null) out.checks.push(check('freeze', 'Freeze authority', 'ok', 'revocata: nessuno può congelare i wallet'));
          else out.checks.push(check('freeze', 'Freeze authority', issuer ? 'info' : 'fail', issuer ? 'attiva, gestita da ' + issuer : 'ATTIVA: i wallet possono essere congelati'));
          const sup = supplyRaw / Math.pow(10, p.decimals);
          out.checks.push(check('supply', 'Supply e decimali', 'ok', mint === WSOL ? 'SOL nativo (wrapped) · 9 decimali' : sup.toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' · ' + p.decimals + ' decimali'));
          const exts = p.extensions || [];
          if (exts.length) {
            const names = exts.map((x) => x.extension);
            out.checks.push(check('ext', 'Estensioni Token-2022', 'ok', names.join(', ')));
            exts.forEach((x) => {
              const s = x.state || {};
              switch (x.extension) {
                case 'permanentDelegate': if (s.delegate) out.checks.push(check('ext-pd', 'Permanent delegate', 'fail', 'un indirizzo può spostare o bruciare i token di chiunque')); break;
                case 'nonTransferable': out.checks.push(check('ext-nt', 'Non trasferibile', 'fail', 'il token non si può trasferire né rivendere')); break;
                case 'defaultAccountState': if (s.accountState === 'frozen') out.checks.push(check('ext-das', 'Stato account di default', 'fail', 'i nuovi account nascono congelati')); break;
                case 'transferHook': if (s.programId) out.checks.push(check('ext-th', 'Transfer hook', 'warn', 'ogni trasferimento esegue un programma esterno (' + mask(s.programId) + ')')); break;
                case 'transferFeeConfig': {
                  const bps = Math.max(Number((s.newerTransferFee || {}).transferFeeBasisPoints || 0), Number((s.olderTransferFee || {}).transferFeeBasisPoints || 0));
                  if (bps > 0) out.checks.push(check('ext-tf', 'Tassa sui trasferimenti', bps >= 500 ? 'fail' : 'warn', (bps / 100).toLocaleString('it-IT') + '% su ogni trasferimento'));
                  else if (s.transferFeeConfigAuthority) out.checks.push(check('ext-tf', 'Tassa sui trasferimenti', 'warn', 'oggi 0%, ma un\'authority può alzarla'));
                  break;
                }
                case 'pausableConfig': case 'pausable': out.checks.push(check('ext-pa', 'Pausabile', 'warn', 'un\'authority può sospendere i trasferimenti')); break;
                case 'mintCloseAuthority': if (s.closeAuthority) out.checks.push(check('ext-mc', 'Mint close authority', 'warn', 'il mint può essere chiuso')); break;
                default: break;
              }
            });
          }
        }
      }
    }

    // 2) RugCheck (rischi, pool note, holder di riserva)
    let rc = null;
    if (fetchJson && mint !== WSOL) {
      try { rc = await fetchJson(RUGCHECK + mint + '/report'); if (rc && !rc.mint) rc = null; if (rc) out.sources.push('rugcheck'); } catch (_) { rc = null; }
    }
    if (rc && rc.tokenMeta) { out.symbol = rc.tokenMeta.symbol || null; out.name = rc.tokenMeta.name || null; }
    const poolOwners = new Set(opts.ammKeys || []);
    if (rc) {
      Object.entries(rc.knownAccounts || {}).forEach(([a, k]) => { if (k && /AMM|LOCKER/i.test(k.type || '')) poolOwners.add(a); });
      (rc.markets || []).forEach((m) => { [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount && m.liquidityAAccount.owner].forEach((a) => a && poolOwners.add(a)); });
    }

    // 3) holder principali
    if (mint === WSOL) out.checks.push(check('top', 'Holder principali', 'ok', 'SOL nativo: non applicabile'));
    else {
      let holders = null; let src = '';
      try {
        const r = await rpc('getTokenLargestAccounts', [mint]);
        if (r && Array.isArray(r.value) && supplyRaw) { holders = r.value.map((h) => ({ address: h.address, owner: null, pct: Number(h.amount) / supplyRaw * 100 })); src = 'RPC'; }
      } catch (_) { holders = null; }
      if (!holders && rc && Array.isArray(rc.topHolders)) { holders = rc.topHolders.map((h) => ({ address: h.address, owner: h.owner, pct: Number(h.pct) })); src = 'RugCheck'; }
      if (!holders || !holders.length) out.checks.push(check('top', 'Holder principali', 'nd', (rc ? 'RPC pubblico limitato e RugCheck senza elenco holder per questo token' : 'RPC pubblico limitato e RugCheck non raggiungibile')));
      else {
        const isPool = (h) => poolOwners.has(h.owner) || poolOwners.has(h.address);
        const pools = holders.filter(isPool); const rest = holders.filter((h) => !isPool(h)).slice(0, 10);
        const top1 = rest.length ? rest[0].pct : 0; const top10 = rest.reduce((s, h) => s + h.pct, 0);
        out.topHolders = rest.map((h) => ({ owner: mask(h.owner || h.address), pct: h.pct }));
        const poolPct = pools.reduce((s, h) => s + h.pct, 0);
        const det = 'top 1: ' + pct(top1) + ' · top 10: ' + pct(top10) + (pools.length ? ' · in pool/AMM: ' + pct(poolPct) : '') + ' (fonte ' + src + (src === 'RPC' ? ', pool riconosciute solo se RugCheck risponde' : '') + ')';
        out.checks.push(check('top', 'Concentrazione holder', top1 > 20 || top10 > 50 ? 'warn' : 'ok', det));
      }
    }

    // 4) RugCheck: rischi
    if (mint === WSOL) { /* niente */ }
    else if (!rc) out.checks.push(check('rug', 'RugCheck', 'nd', 'report non disponibile'));
    else {
      if (rc.rugged) out.checks.push(check('rug', 'RugCheck', 'fail', 'segnalato come RUGGED'));
      const danger = (rc.risks || []).filter((r) => r.level === 'danger').map((r) => r.name);
      const warn = (rc.risks || []).filter((r) => r.level === 'warn').map((r) => r.name);
      if (!rc.rugged) out.checks.push(check('rug', 'RugCheck', danger.length ? 'warn' : 'ok',
        (danger.length ? 'rischi: ' + danger.join(', ') : 'nessun rischio grave') + (warn.length ? ' · avvisi: ' + warn.join(', ') : '') + (rc.score_normalised != null ? ' · punteggio ' + rc.score_normalised + '/100 (più basso = meglio)' : '')));
      if (!(rc.markets || []).length) out.checks.push(check('lp', 'Liquidità nei mercati', 'nd', 'RugCheck non ha mercati indicizzati per questo token'));
      else if (rc.totalMarketLiquidity != null) out.checks.push(check('lp', 'Liquidità nei mercati', Number(rc.totalMarketLiquidity) < 1000 ? 'warn' : 'ok', '$' + Math.round(Number(rc.totalMarketLiquidity)).toLocaleString('it-IT') + ' (stima RugCheck)'));
    }

    out.fails = out.checks.filter((c) => c.status === 'fail').length;
    out.warns = out.checks.filter((c) => c.status === 'warn').length;
    const partial = out.checks.some((c) => c.status === 'nd');
    out.verdict = out.fails ? 'BLOCCATO' : out.warns ? 'ATTENZIONE' : partial ? 'NESSUN RED FLAG (controlli parziali)' : 'NESSUN RED FLAG';
    return out;
  }

  // Spiegazione in italiano del routePlan di Jupiter. sym(mint) -> simbolo ; dec(mint) -> decimali o null
  function explainRoute(quote, sym, dec) {
    sym = sym || mask; dec = dec || (() => null);
    const fmt = (raw, m) => { const d = dec(m); return d == null ? String(raw) + ' (unità base)' : (Number(raw) / Math.pow(10, d)).toLocaleString('it-IT', { maximumFractionDigits: Math.min(d, 6) }); };
    const steps = (quote.routePlan || []).map((s, i) => {
      const si = s.swapInfo || {};
      return { n: i + 1, percent: s.percent, dex: si.label || 'AMM', amm: si.ammKey,
        text: 'Passo ' + (i + 1) + ': ' + (s.percent != null ? s.percent + '% · ' : '') + fmt(si.inAmount, si.inputMint) + ' ' + sym(si.inputMint) + ' → ' + fmt(si.outAmount, si.outputMint) + ' ' + sym(si.outputMint) + ' su ' + (si.label || 'AMM') };
    });
    const splits = steps.length > 1 ? 'Jupiter divide o concatena lo scambio in ' + steps.length + ' passaggi per ottenere un prezzo migliore.' : 'Scambio diretto su un solo mercato.';
    return { steps, summary: splits, priceImpactPct: Number(quote.priceImpactPct || 0) * 100, minOut: quote.otherAmountThreshold, slippageBps: quote.slippageBps, platformFee: quote.platformFee };
  }

  return { kiraReport, explainRoute, isMint, mask, KNOWN_ISSUERS, TOKEN_2022, TOKEN_V1, WSOL };
});
