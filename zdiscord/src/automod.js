'use strict';
// Regole AutoMod native di Discord gestite da /setup-server. Logica pura (piano) + adattatori per discord.js.
// Richiede il permesso Manage Guild: senza, l'anteprima lo segnala e applica salta questa parte.
// © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
const T = { Keyword: 1, Spam: 3, MentionSpam: 5 };
const A = { BlockMessage: 1, SendAlertMessage: 2 };
const PREFIX = 'ZDOS · ';

const DOMAINS = ['x-zdos.it', 'discord.com', 'discord.gg', 'discordapp.com', 'discord.media', 'solscan.io', 'polygonscan.com', 'jup.ag', 't.me', 'telegram.me'];
// "*://dominio" = l'host è esattamente il dominio; "*.dominio" = sottodomini. Il match è sul tratto "https://host".
const LINK_ALLOW = DOMAINS.flatMap((d) => ['*://' + d, '*.' + d, '*://www.' + d]);
const SCAM = [
  '*free nitro*', '*nitro gratis*', '*send your seed phrase*', '*share your seed phrase*', '*enter your seed phrase*',
  '*invia la tua seed*', '*inserisci la tua seed*', '*mandami la seed*', '*claim your airdrop*', '*claim airdrop*',
  '*sync your wallet*', '*sincronizza il tuo wallet*', '*validate your wallet*', '*rendimento garantito*',
  '*guadagno garantito*', '*guaranteed profit*', '*guaranteed returns*', '*double your crypto*', '*raddoppia le tue crypto*',
];

function desired(modLogId) {
  const alert = modLogId ? [{ type: A.SendAlertMessage, channelId: modLogId }] : [];
  const block = (m) => ({ type: A.BlockMessage, customMessage: m });
  return [
    { name: PREFIX + 'anti-spam', triggerType: T.Spam, meta: {}, actions: [block('Messaggio bloccato: sembra spam.'), ...alert] },
    { name: PREFIX + 'menzioni di massa', triggerType: T.MentionSpam, meta: { mentionTotalLimit: 5, mentionRaidProtectionEnabled: true }, actions: [block('Troppe menzioni in un messaggio.'), ...alert] },
    { name: PREFIX + 'link esterni', triggerType: T.Keyword, meta: { regexPatterns: ['https?://[^\\s/<>]+'], allowList: LINK_ALLOW }, actions: [block('Link non ammesso: sono consentiti solo x-zdos.it, t.me/OurVelvetHub, discord, solscan, polygonscan, jup.ag.'), ...alert] },
    { name: PREFIX + 'Telegram solo ufficiale', triggerType: T.Keyword, meta: { regexPatterns: ['(?:t|telegram)\\.me/[A-Za-z0-9_+]+'], allowList: ['t.me/OurVelvetHub', 'telegram.me/OurVelvetHub'] }, actions: [block('Su Telegram è ammesso solo t.me/OurVelvetHub.'), ...alert] },
    { name: PREFIX + 'frasi truffa', triggerType: T.Keyword, meta: { keywordFilter: SCAM }, actions: [block('Messaggio bloccato: frase tipica delle truffe. Lo staff non chiede mai seed phrase o pagamenti.'), ...alert] },
  ];
}

// Forma canonica (indipendente da discord.js) per confrontare regola esistente e desiderata.
function canon(r) {
  const m = r.meta || {};
  const arr = (x) => [...(x || [])].map(String).sort();
  return JSON.stringify({
    t: r.triggerType, e: r.enabled !== false,
    k: arr(m.keywordFilter), re: arr(m.regexPatterns), al: arr(m.allowList),
    ml: m.mentionTotalLimit || 0, mr: !!m.mentionRaidProtectionEnabled,
    a: (r.actions || []).map((a) => [a.type, a.channelId || null, a.customMessage || null]).sort((x, y) => String(x).localeCompare(String(y))),
  });
}

// Da AutoModerationRule di discord.js alla forma semplice.
function fromDiscord(rule) {
  const tm = rule.triggerMetadata || {};
  return {
    id: rule.id, name: rule.name, triggerType: rule.triggerType, enabled: rule.enabled,
    meta: { keywordFilter: tm.keywordFilter, regexPatterns: tm.regexPatterns, allowList: tm.allowList, mentionTotalLimit: tm.mentionTotalLimit, mentionRaidProtectionEnabled: tm.mentionRaidProtectionEnabled },
    actions: (rule.actions || []).map((a) => ({ type: a.type, channelId: (a.metadata && a.metadata.channelId) || null, customMessage: (a.metadata && a.metadata.customMessage) || null })),
  };
}

// existing: regole già sul server (forma semplice). Le regole di altri (senza prefisso ZDOS) non si toccano.
function plan(existing, modLogId) {
  const out = []; const warnings = [];
  for (const d of desired(modLogId)) {
    const ex = (existing || []).find((x) => x.name === d.name);
    // Discord ammette una sola regola Spam e una sola MentionSpam per server: se ne esiste già una di altri, la lascio.
    const other = (existing || []).find((x) => x.name !== d.name && x.triggerType === d.triggerType && (d.triggerType === T.Spam || d.triggerType === T.MentionSpam));
    if (!ex && other) { warnings.push('AutoMod: esiste già la regola "' + other.name + '" dello stesso tipo di "' + d.name + '": lasciata com\'è.'); continue; }
    if (!ex) out.push({ op: 'automod.create', name: d.name, rule: d });
    else if (canon({ ...ex, enabled: ex.enabled }) !== canon({ ...d, enabled: true })) out.push({ op: 'automod.update', id: ex.id, name: d.name, rule: d });
  }
  const kw = (existing || []).filter((x) => x.triggerType === T.Keyword && !x.name.startsWith(PREFIX)).length;
  const newKw = out.filter((a) => a.op === 'automod.create' && a.rule.triggerType === T.Keyword).length;
  if (kw + newKw + (existing || []).filter((x) => x.triggerType === T.Keyword && x.name.startsWith(PREFIX)).length > 6) warnings.push('AutoMod: Discord ammette al massimo 6 regole a parole chiave; alcune regole ZDOS potrebbero non essere create.');
  return { actions: out, warnings };
}

function toDiscord(d, resolve = (x) => x) {
  return {
    name: d.name, eventType: 1, triggerType: d.triggerType, enabled: true,
    triggerMetadata: d.meta,
    actions: d.actions.map((a) => ({ type: a.type, metadata: a.type === A.SendAlertMessage ? { channel: resolve(a.channelId) } : { customMessage: a.customMessage } })),
    reason: 'setup-server z-xSOLANA: moderazione automatica',
  };
}

module.exports = { desired, plan, canon, fromDiscord, toDiscord, PREFIX, LINK_ALLOW, SCAM, T, A };
