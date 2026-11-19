'use strict';
// Definizioni e logica dei comandi slash. La logica restituisce oggetti semplici (embed JSON),
// così si testa senza token e senza Discord.
const K = require('./kira-core');
const C = require('./constants');

const DEFS = [
  { name: 'kira', description: 'Controlli K.I.R.A. reali su un token Solana', options: [{ type: 3, name: 'mint', description: 'Indirizzo del mint', required: true, min_length: 32, max_length: 44 }] },
  { name: 'stato', description: "Stato dei servizi dell'ecosistema ZDOS" },
  { name: 'token', description: 'Informazioni su $DSN e VELVET' },
  { name: 'radar', description: 'Ultimi segnali del Radar zdesk (sola lettura)' },
  { name: 'verifica', description: 'Ottieni i ruoli holder firmando un messaggio con il tuo wallet' },
  { name: 'quest', description: 'Link a ZQuest' },
  { name: 'setup-server', description: 'Struttura, messaggi guida, AutoMod e anti-raid (solo owner/admin). Prima usa anteprima.', default_member_permissions: '8', options: [
    { type: 1, name: 'anteprima', description: 'Mostra le modifiche senza applicarle', options: [{ type: 5, name: 'archivia_vecchie', description: 'Rinomina le categorie esistenti con 🗄️ (non sposta né cancella canali)', required: false }] },
    { type: 1, name: 'applica', description: 'Applica la struttura (idempotente, non cancella canali)', options: [{ type: 5, name: 'archivia_vecchie', description: 'Rinomina le categorie esistenti con 🗄️ (non sposta né cancella canali)', required: false }] },
  ] },
  { name: 'rubina', description: 'Parla con Rubina (IA) · solo nei canali 18+ della 18+ ROOM', options: [
    { type: 3, name: 'messaggio', description: 'Il tuo messaggio (ROSSO la ferma subito)', required: false, max_length: 1000 },
    { type: 5, name: 'riprendi', description: 'Riprendi dopo una pausa ROSSO', required: false },
  ] },
  { name: 'velvet', description: 'VelvetHub 18+: mini app, Radar della Carne, categorie e regole del club' },
  { name: 'ingresso-18', description: 'Accesso alla 18+ ROOM: dichiarazione di età e regole' },
  { name: 'curioso', description: 'Prendi o togli il ruolo Curioso (serve Verificato 18+)' },
  { name: 'radar-collega', description: 'Collega il tuo profilo del Radar della Carne e ricevi il ruolo', options: [
    { type: 3, name: 'tipo', description: 'Mistress/Master oppure Fedele', required: true, choices: [{ name: 'Mistress / Master', value: 'mistress' }, { name: 'Fedele', value: 'fedele' }] },
    { type: 3, name: 'token', description: 'Token di gestione (Mistress/Master) o token del Fedele dato dal Radar', required: true, min_length: 10, max_length: 100 },
    { type: 3, name: 'handle', description: 'Handle X del profilo Mistress/Master (senza @)', required: false, max_length: 16 },
    { type: 4, name: 'id', description: 'Numero del Fedele dato dal Radar', required: false, min_value: 1 },
  ] },
  { name: 'radar-scollega', description: 'Scollega il Radar della Carne e togli i ruoli collegati' },
].map((d) => ({ ...d, dm_permission: false }));

const ICON = { ok: '✅', info: 'ℹ️', warn: '⚠️', fail: '⛔', nd: '➖' };
const FOOT = { text: 'z-xSOLANA · ZDOS1.3 · informativo, non è consulenza finanziaria' };
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

async function kira(mint, deps) {
  mint = String(mint || '').trim();
  if (!K.isMint(mint)) return { ephemeral: true, embeds: [{ title: 'K.I.R.A.', description: 'Indirizzo non valido: serve il mint Solana (32-44 caratteri base58).', color: C.COLORS.fail }] };
  const r = await K.kiraReport(mint, { rpc: deps.rpc, fetchJson: deps.fetchJson });
  const color = r.fails ? C.COLORS.fail : r.warns ? C.COLORS.warn : C.COLORS.green;
  return { embeds: [{
    title: clip('K.I.R.A. · ' + (r.symbol || K.mask(mint)) + ' · ' + r.verdict, 256),
    url: 'https://solscan.io/token/' + mint,
    color,
    description: r.checks.map((c) => ICON[c.status] + ' **' + c.label + '**: ' + c.detail).join('\n').slice(0, 4000),
    fields: [
      { name: 'Mint', value: '`' + mint + '`' },
      { name: 'Link', value: '[Solscan](https://solscan.io/token/' + mint + ') · [DexScreener](https://dexscreener.com/solana/' + mint + ') · [zRoute](https://swap.x-zdos.it/zroute/)' },
      { name: 'Fonti', value: r.sources.join(', ') || 'n/d', inline: true },
    ],
    footer: FOOT,
  }] };
}

async function stato(deps) {
  const rows = await Promise.all(C.HEALTH.map(async ([name, url]) => {
    const t0 = Date.now();
    try { const r = await deps.fetchStatus(url); return { name, ok: r >= 200 && r < 400, code: r, ms: Date.now() - t0 }; }
    catch (e) { return { name, ok: false, code: 'errore', ms: Date.now() - t0 }; }
  }));
  let zd = { name: 'zdesk API (locale)', ok: false, code: 'n/d' };
  try {
    const h = await deps.zdeskJson('/api/health');
    zd = { name: 'zdesk API (locale)', ok: !!h.ok, code: h.ok ? 'ok' : 'ko', extra: h.trading === false ? 'trading spento, solo simulazione' : (h.trading ? 'trading ATTIVO' : '') };
  } catch (_) { zd.code = 'non raggiungibile'; }
  rows.push(zd);
  const allOk = rows.every((x) => x.ok);
  return { embeds: [{
    title: 'Stato ecosistema ZDOS', color: allOk ? C.COLORS.green : C.COLORS.warn,
    description: rows.map((x) => (x.ok ? '🟢' : '🔴') + ' **' + x.name + '** · ' + x.code + (x.ms != null ? ' · ' + x.ms + ' ms' : '') + (x.extra ? ' · ' + x.extra : '')).join('\n'),
    footer: { text: 'Controllo eseguito ora dal server ZDOS' }, timestamp: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
  }] };
}

async function token(deps) {
  let velvetLine = 'Prezzo e liquidità: n/d';
  try {
    const d = await deps.fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + C.VELVET);
    const p = (d.pairs || []).filter((x) => x.chainId === 'solana').sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0];
    if (p) { const liq = Math.round((p.liquidity || {}).usd || 0); velvetLine = 'Prezzo: $' + p.priceUsd + ' · liquidità: ' + (liq > 0 ? '$' + liq.toLocaleString('it-IT') : 'non riportata da DexScreener') + ' (DexScreener, ora)'; }
  } catch (_) { /* n/d */ }
  return { embeds: [{
    title: 'Token ZDOS', color: C.COLORS.violet,
    fields: [
      { name: '$DSN · Solana (ufficiale)', value: '`' + C.DSN_SOL + '`\nToken-2022 · 6 decimali · mint e freeze authority revocate · **nessuna pool**: oggi non è scambiabile su Solana.\n[Solscan](https://solscan.io/token/' + C.DSN_SOL + ') · [DexScreener](https://dexscreener.com/solana/' + C.DSN_SOL + ')' },
      { name: '$DSN · Polygon', value: '`' + C.DSN_POLYGON + '`\n[Polygonscan](https://polygonscan.com/token/' + C.DSN_POLYGON + ')' },
      { name: 'VELVET ($OV) · Solana', value: '`' + C.VELVET + '`\n' + velvetLine + '\n[Solscan](https://solscan.io/token/' + C.VELVET + ') · [DexScreener](https://dexscreener.com/solana/' + C.VELVET + ')' },
    ],
    description: 'Nessun rendimento promesso, nessun airdrop. Prima di comprare usa /kira o [zRoute](https://swap.x-zdos.it/zroute/).',
    footer: FOOT,
  }] };
}

async function radar(deps) {
  let r;
  try { r = await deps.zdeskJson('/api/radar'); }
  catch (_) { return { ephemeral: true, embeds: [{ title: 'Radar zdesk', color: C.COLORS.warn, description: "L'API locale di zdesk non risponde in questo momento: niente segnali da mostrare." }] }; }
  const fp = ((r.news && r.news.fastPairs) || []).slice(0, 5);
  const ki = ((r.kira && r.kira.items) || []).slice(0, 5);
  const lines = [];
  if (fp.length) lines.push('**Coppie veloci (volume 1h)**\n' + fp.map((x) => '• ' + clip(x.symbol || '?', 24) + ' · vol 1h $' + Math.round(x.volH1 || 0).toLocaleString('it-IT') + ' · liq $' + Math.round(x.liqUsd || 0).toLocaleString('it-IT') + ' · età ' + (x.ageMin != null ? x.ageMin + ' min' : 'n/d') + (x.mint ? ' · `' + x.mint + '`' : '')).join('\n'));
  if (ki.length) lines.push('**K.I.R.A. sulla watchlist**\n' + ki.map((x) => '• ' + clip(x.symbol || K.mask(x.mint || ''), 24) + ' · ' + (x.verdict || (x.kira && x.kira.verdict) || 'n/d')).join('\n'));
  if (!lines.length) lines.push(r.kira && r.kira.running ? 'Il Radar sta aggiornando i dati: riprova tra qualche minuto.' : 'Nessun segnale disponibile in questo momento.');
  const ex = (r.x && r.x.example) || (r.news && r.news.example);
  return { ephemeral: true, embeds: [{
    title: 'Radar zdesk · sola lettura', color: C.COLORS.cyan,
    description: lines.join('\n\n').slice(0, 4000),
    fields: [{ name: 'Nota', value: (r.disclaimer || 'Segnali informativi in sola lettura.') + (ex ? ' Le sezioni X e news del Radar oggi contengono dati di esempio, non mostrati qui.' : '') + ' Prima di comprare usa /kira.' }],
    footer: FOOT, timestamp: r.updatedAt || undefined,
  }] };
}

function quest() {
  return { embeds: [{ title: 'ZQuest', url: 'https://quest.x-zdos.it', color: C.COLORS.green, description: 'Missioni e progressi dell\'ecosistema ZDOS: [quest.x-zdos.it](https://quest.x-zdos.it). Nessun premio in token promesso.', footer: FOOT }] };
}

function verifica(ctx, deps) {
  if (!ctx.guildId) return { ephemeral: true, content: 'Usa /verifica dentro il server z-xSOLANA.' };
  const rec = deps.store.create(ctx.guildId, ctx.userId);
  const url = deps.verifyUrl + '?n=' + encodeURIComponent(rec.nonce);
  return { ephemeral: true, embeds: [{
    title: 'Verifica holder', color: C.COLORS.violet, url,
    description: 'Apri il link, collega Phantom e firma il messaggio. È una firma di testo: nessuna transazione, nessun accesso ai fondi.\nSe hai $DSN o VELVET ricevi i ruoli **' + deps.roles.dsn + '** e/o **' + deps.roles.velvet + '**.\n\n[Apri la pagina di verifica](' + url + ')\nIl link vale ' + Math.round((rec.exp - Date.now()) / 60000) + ' minuti e si usa una sola volta.',
  }] };
}

function velvet() {
  const club = require('./club');
  return { embeds: [{
    title: '🖤 VelvetHub 18+ · Velvet Club', url: 'https://velvet.x-zdos.it/app', color: 0xffd56a,
    description: 'Il club 18+ di ZDOS1.3: sala, Radar della Carne, contest ed eventi. Solo adulti verificati, consenso sempre, safeword **ROSSO**.',
    fields: [
      { name: 'Mini app', value: '[velvet.x-zdos.it/app](https://velvet.x-zdos.it/app) · Telegram [@OurVelvetHub](https://t.me/OurVelvetHub)' },
      { name: 'Radar della Carne', value: '[Apri il Radar](https://velvet.x-zdos.it/app#radar-section). Profili Mistress/Master verificati con un post X; Fedeli e Curiosi solo per scelta (opt-in). Collega il tuo profilo con /radar-collega.' },
      { name: 'Categorie del club', value: club.LAYOUT.find((l) => l.key === 'club').channels.map((c) => '#' + c.name).join(' · ') },
      { name: 'Ruoli', value: 'Verificato 18+ (#ingresso-18) · Curioso (/curioso) · Fedele, Mistress, Master (/radar-collega) · Creator (assegnato dagli admin ai creator verificati)' },
      { name: 'Regole', value: club.RULES_18.slice(0, 5).map((r) => '• ' + r).join('\n').slice(0, 1024) },
    ],
    footer: { text: 'VelvetHub 18+ by ZDOS1.3 · VELVET è un token di comunità, nessun rendimento' },
  }] };
}

async function dispatch(name, ctx, deps) {
  switch (name) {
    case 'kira': return kira(ctx.options.mint, deps);
    case 'stato': return stato(deps);
    case 'token': return token(deps);
    case 'radar': return radar(deps);
    case 'verifica': return verifica(ctx, deps);
    case 'quest': return quest();
    case 'velvet': return velvet();
    default: return { ephemeral: true, content: 'Comando sconosciuto.' };
  }
}

module.exports = { DEFS, dispatch, kira, stato, token, radar, quest, verifica, velvet };
