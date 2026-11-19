'use strict';
// Struttura del server z-xSOLANA + Velvet Club (18+) e pianificazione idempotente delle modifiche.
// Logica pura: riceve una fotografia del server e restituisce la lista di azioni, così si testa offline.
// © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.

// Permessi Discord (bit ufficiali, API v10).
const P = {
  ManageChannels: 1n << 4n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n, EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n, ReadMessageHistory: 1n << 16n, ManageRoles: 1n << 28n, UseApplicationCommands: 1n << 31n,
  ManageGuild: 1n << 5n, PinMessages: 1n << 51n,
};
// Il bot può impostare in un override solo permessi che ha anche lui: per questo servono AttachFiles e ReadMessageHistory.
const BOT_PERMS = P.ManageChannels | P.ViewChannel | P.SendMessages | P.EmbedLinks | P.AttachFiles | P.ReadMessageHistory | P.ManageRoles | P.UseApplicationCommands;
// Permessi aggiuntivi, non bloccanti: Manage Guild serve solo per le regole AutoMod native, Pin Messages solo per fissare
// i messaggi guida. Se mancano, /setup-server anteprima lo segnala e applica salta solo quelle parti.
const EXTRA_PERMS = { ManageGuild: P.ManageGuild, PinMessages: P.PinMessages };
const INVITE_PERMS = BOT_PERMS | P.ManageGuild | P.PinMessages;

const ROLES = [
  { key: 'dsn', name: 'Holder $DSN', color: 0x9945ff, hoist: false },
  { key: 'velvet', name: 'Holder VELVET', color: 0xff4ecd, hoist: false },
  { key: 'v18', name: 'Verificato 18+', color: 0xffd56a, hoist: false },
  { key: 'mistress', name: 'Mistress', color: 0xff4ecd, hoist: true },
  { key: 'master', name: 'Master', color: 0x9945ff, hoist: true },
  { key: 'creator', name: 'Creator', color: 0xffd56a, hoist: true },
  { key: 'fedele', name: 'Fedele', color: 0x66e3ff, hoist: false },
  { key: 'curioso', name: 'Curioso', color: 0x14f195, hoist: false },
  // Anti-raid: chi entra con un account troppo nuovo (o durante un raid) riceve questo ruolo e vede solo #verifica-accesso.
  { key: 'quarantena', name: 'In verifica', color: 0x8a8f98, hoist: false },
];

const RULES_18 = [
  'Solo adulti (18+) verificati: ruolo **Verificato 18+** dal canale #ingresso-18.',
  'Consenso esplicito, sempre. I limiti si dichiarano prima.',
  'Safeword **ROSSO**: ferma tutto, subito, senza discussioni.',
  'Nessun minore. Nessun personaggio dall\'aspetto minorile, nessun age-play.',
  'Vietati non-consenso, incesto, violenza reale, persone reali senza il loro consenso.',
  'I contenuti (immagini, video, audio, link) li caricano solo i **Creator** verificati 18+. Gli altri commentano.',
  'Niente contatti, incontri, indirizzi o posizioni. Niente richieste di soldi o crypto in privato.',
  'Il bot non genera contenuti sessuali espliciti, né testo né immagini.',
];

// access: public | readonly | holder | adult | adult-ro | club | staff
const LAYOUT = [
  { key: 'annunci', name: '📢 ANNUNCI', access: 'public', channels: [
    { name: 'annunci', access: 'readonly', topic: 'Annunci ufficiali ZDOS e Velvet Club. Solo lettura.' },
    { name: 'benvenuto', access: 'readonly', topic: 'Benvenuto nel server z-xSOLANA by ZDOS1.3. Regole generali e link utili.' },
    { name: 'regole', access: 'readonly', topic: 'Regole generali del server $DSN by ZDOS1.3. Leggile prima di scrivere.' },
    { name: 'verifica-accesso', access: 'quarantine', topic: 'Account nuovi o ingressi durante un raid: qui aspetti la verifica dello staff.' },
    { name: 'ingresso-18', access: 'readonly', topic: 'Accesso alla 18+ ROOM e al Velvet Club: dichiarazione di maggiore età e accettazione delle regole.' },
  ] },
  // Airdrop VELVET: regole in sola lettura + canale domande. Nessun ruolo airdrop creato o assegnato dal bot.
  { key: 'airdrop', name: '🎁 AIRDROP VELVET', access: 'public', channels: [
    { name: 'airdrop-velvet', access: 'readonly', topic: 'Airdrop VELVET ($OV) 15/12/2026–24/03/2027: regole ufficiali, solo lettura. Nessun guadagno promesso, DYOR.' },
    { name: 'airdrop-domande', topic: 'Domande sull\'airdrop VELVET. Lo staff non scrive mai in DM per primo. Mai condividere seed phrase o chiavi.' },
  ] },
  { key: 'zx', name: '🌐 Z-XSOLANA', access: 'public', channels: [
    { name: 'info', access: 'readonly', topic: 'Cos\'è z-xSOLANA: $DSN, VELVET, zRoute, Zlang IDE. Nessun rendimento promesso.' },
    { name: 'stato', topic: 'Usa /stato per lo stato dei servizi ZDOS.' },
    { name: 'kira', topic: 'Usa /kira <mint> per i controlli K.I.R.A. su un token Solana.' },
    { name: 'radar', topic: 'Usa /radar per gli ultimi segnali del Radar zdesk (sola lettura).' },
    { name: 'ide', access: 'readonly', topic: 'Zlang IDE: https://x-zdos.it/ide/' },
    { name: 'zroute', access: 'readonly', topic: 'zRoute: swap via Jupiter con controlli K.I.R.A. https://swap.x-zdos.it/zroute/' },
  ] },
  { key: 'giochi', name: '🎮 GIOCHI', access: 'public', channels: [
    { name: 'rpg-pinguino', topic: 'RPG del pinguino ZDOS.' },
    { name: 'zquest', topic: 'ZQuest: missioni dell\'ecosistema. https://quest.x-zdos.it' },
  ] },
  { key: 'holder', name: '💎 HOLDER', access: 'holder', channels: [
    { name: 'holder-lounge', topic: 'Per chi ha Holder $DSN o Holder VELVET (verifica con /verifica, solo firma, nessun accesso ai fondi).' },
  ] },
  { key: 'room18', name: '🔞 18+ ROOM', access: 'adult', nsfw: true, channels: [
    { name: 'regole-18', access: 'adult-ro', topic: 'Regole della 18+ ROOM e del Velvet Club. Leggile prima di scrivere.' },
    { name: 'rubina', topic: 'Rubina, padrona di casa del Velvet Club (IA). Usa /rubina. ROSSO la ferma subito.' },
    { name: 'velvet-eventi', access: 'adult-ro', topic: 'Eventi, contest e Radar della Carne pubblicati in automatico da VelvetHub.' },
    { name: 'contest', topic: 'Contest del Velvet Club: regolamenti e partecipazione. Contenuti solo dai Creator verificati.' },
    { name: 'gioco-18', access: 'adult-ro', topic: 'Il nuovo gioco 18+ del Velvet Club: in progettazione, nessun contenuto ancora.' },
    { name: 'radar-della-carne', topic: 'Radar della Carne di VelvetHub: collega il tuo profilo con /radar-collega. Opt-in, cancellabile.' },
  ] },
  { key: 'club', name: '🖤 VELVET CLUB', access: 'club', nsfw: true, channels: [
    { name: 'bdsm-consensuale', topic: 'BDSM & sado-maso consensuale tra adulti. SSC/RACK, limiti dichiarati, safeword ROSSO.' },
    { name: 'fetish', topic: 'Fetish tra adulti: materiali, abbigliamento, estetiche. Rispetta i limiti altrui.' },
    { name: 'lgbtq', topic: 'Spazio LGBTQ+ e alleati. Pronomi rispettati, zero discriminazioni.' },
    { name: 'coppie', topic: 'Coppie di adulti, entrambi verificati 18+ e consenzienti.' },
    { name: 'solo-creator', topic: 'Creator che lavorano da soli: set, sessioni, progetti.' },
    { name: 'mistress-master', topic: 'Mistress e Master verificati sul Radar della Carne.', uploaders: ['creator', 'mistress', 'master'] },
    { name: 'creator-showcase', topic: 'Vetrina dei Creator verificati 18+. Solo i Creator caricano, gli altri commentano.' },
    { name: 'asmr-audio', topic: 'ASMR e audio per adulti, caricati dai Creator verificati.' },
    { name: 'cosplay-adulti', topic: 'Cosplay di adulti interpretati da adulti. Vietati personaggi minorenni o dall\'aspetto minorile.' },
  ] },
  { key: 'staff', name: '🛡️ STAFF', access: 'staff', channels: [
    { name: 'bozze-x', topic: 'Bozze per X generate dagli eventi: le apri e le pubblichi tu. Il bot non pubblica mai su X.' },
    { name: 'log-bot', topic: 'Log del bot (setup, errori del relay).' },
    { name: 'mod-log', topic: 'Moderazione automatica: avvisi AutoMod, ingressi in verifica, raid. Solo staff.' },
  ] },
];
const ARCHIVE = { key: 'archivio', name: '🗄️ ARCHIVIO' };
const ADULT_CATS = ['room18', 'club'];

const norm = (s) => String(s || '').normalize('NFKD').replace(/[^\p{L}\p{N}+]+/gu, ' ').trim().toLowerCase();
const catKey = (name) => { const n = norm(name); const all = [...LAYOUT, ARCHIVE]; const c = all.find((x) => norm(x.name) === n); return c ? c.key : null; };

// Override per tipo di accesso. ids: { everyone, bot, roles: { key: id } }
function overwrites(access, ids, ch = {}) {
  const r = ids.roles; const ow = [];
  const bot = { id: ids.bot, type: 1, allow: P.ViewChannel | P.SendMessages | P.EmbedLinks | P.ReadMessageHistory, deny: 0n };
  const ro = P.SendMessages;
  // Chi è "In verifica" non vede i canali pubblici finché lo staff non lo approva (o l'account non è abbastanza vecchio).
  const q = r.quarantena ? [{ id: r.quarantena, type: 0, allow: 0n, deny: P.ViewChannel }] : [];
  switch (access) {
    case 'public': ow.push(...q); break;
    case 'readonly': ow.push({ id: ids.everyone, type: 0, allow: 0n, deny: ro }, bot, ...q); break;
    case 'quarantine':
      ow.push({ id: ids.everyone, type: 0, allow: 0n, deny: P.ViewChannel }, bot);
      if (r.quarantena) ow.push({ id: r.quarantena, type: 0, allow: P.ViewChannel | P.ReadMessageHistory, deny: P.SendMessages });
      break;
    case 'holder':
      ow.push({ id: ids.everyone, type: 0, allow: 0n, deny: P.ViewChannel }, bot);
      for (const k of ['dsn', 'velvet']) if (r[k]) ow.push({ id: r[k], type: 0, allow: P.ViewChannel | P.SendMessages | P.ReadMessageHistory, deny: 0n });
      break;
    case 'adult': case 'adult-ro': case 'club': {
      ow.push({ id: ids.everyone, type: 0, allow: 0n, deny: P.ViewChannel }, bot);
      const canSend = access !== 'adult-ro';
      if (r.v18) ow.push({ id: r.v18, type: 0, allow: P.ViewChannel | P.ReadMessageHistory | (canSend ? P.SendMessages : 0n), deny: (canSend ? 0n : P.SendMessages) | P.AttachFiles | P.EmbedLinks });
      if (canSend) for (const k of ch.uploaders || ['creator']) if (r[k]) ow.push({ id: r[k], type: 0, allow: P.AttachFiles | P.EmbedLinks, deny: 0n });
      break;
    }
    case 'staff': ow.push({ id: ids.everyone, type: 0, allow: 0n, deny: P.ViewChannel }, bot); break;
    default: break;
  }
  return ow;
}
const owKey = (ow) => JSON.stringify([...ow].map((o) => [String(o.id), o.type, String(BigInt(o.allow)), String(BigInt(o.deny))]).sort());

// Canali protetti: non vengono spostati in Archivio, non ricevono l'override anti-raid e non vengono modificati.
// protect = { names: ['collab'], ids: [], inviteChannelIds: [] } (nomi = sottostringa, senza maiuscole/accenti).
function protectedChannels(snap, protect = {}) {
  const out = new Map();
  const names = (protect.names || []).map((n) => norm(n)).filter(Boolean);
  const ids = new Set((protect.ids || []).map(String).filter(Boolean));
  const inv = new Set((protect.inviteChannelIds || []).map(String).filter(Boolean));
  for (const c of snap.channels) {
    if (c.type === 4) continue;
    const n = norm(c.name);
    if (ids.has(String(c.id))) out.set(c.id, 'lista ID');
    else if (names.some((x) => n.includes(x))) out.set(c.id, 'nome contiene "' + names.find((x) => n.includes(x)) + '"');
    else if (inv.has(String(c.id))) out.set(c.id, 'invito pubblico permanente attivo');
  }
  return out;
}

/**
 * snap: { everyoneId, botId, botTopRolePosition, roles:[{id,name,color,position,managed}],
 *         channels:[{id,name,type,parentId,nsfw,topic,position,overwrites:[{id,type,allow,deny}]}] }
 * type: 0 testo, 2 voce, 4 categoria, 5 annunci, 13 stage, 15 forum
 * Restituisce { actions, warnings }. Gli id dei ruoli/categorie ancora da creare sono segnaposto "new:<key>".
 */
function plan(snap, opts = {}) {
  const actions = []; const warnings = [];
  const prot = protectedChannels(snap, opts.protect);
  const roleIds = {};
  for (const R of ROLES) {
    const ex = snap.roles.find((x) => x.name === R.name);
    if (!ex) { actions.push({ op: 'role.create', key: R.key, name: R.name, color: R.color, hoist: R.hoist }); roleIds[R.key] = 'new:' + R.key; continue; }
    roleIds[R.key] = ex.id;
    if (ex.color !== R.color || (ex.hoist != null && ex.hoist !== R.hoist)) actions.push({ op: 'role.update', id: ex.id, name: R.name, color: R.color, hoist: R.hoist });
    if (snap.botTopRolePosition != null && ex.position >= snap.botTopRolePosition) warnings.push('Il ruolo "' + R.name + '" è sopra il ruolo del bot: trascina il ruolo del bot più in alto, altrimenti non può assegnarlo.');
  }
  const ids = { everyone: snap.everyoneId, bot: snap.botId, roles: roleIds };
  const cats = snap.channels.filter((c) => c.type === 4);
  const managed = new Set(); const catIds = {};
  const order = [];
  for (const L of [...LAYOUT, ARCHIVE]) {
    const ex = cats.find((c) => catKey(c.name) === L.key);
    const ow = L.key === 'archivio' ? null : overwrites(L.access === 'adult' || L.access === 'club' ? L.access : L.access, ids);
    if (!ex) { actions.push({ op: 'category.create', key: L.key, name: L.name, overwrites: ow || [] }); catIds[L.key] = 'new:' + L.key; }
    else {
      catIds[L.key] = ex.id; managed.add(ex.id);
      if (ex.name !== L.name) actions.push({ op: 'category.rename', id: ex.id, from: ex.name, name: L.name });
      if (ow && owKey(ex.overwrites || []) !== owKey(ow)) actions.push({ op: 'category.perms', id: ex.id, name: L.name, overwrites: ow });
    }
    order.push({ ref: catIds[L.key], kind: 'category' });
  }
  for (const L of LAYOUT) {
    for (const C of L.channels) {
      const access = C.access || L.access;
      const ow = overwrites(access === 'public' ? 'public' : access, ids, C);
      const nsfw = !!L.nsfw;
      const ex = snap.channels.find((c) => c.type === 0 && c.name === C.name && !managed.has(c.id));
      if (ex && prot.has(ex.id)) { managed.add(ex.id); warnings.push('#' + C.name + ' è protetto (' + prot.get(ex.id) + '): lasciato com\'è, nessuna modifica.'); continue; }
      if (!ex) { actions.push({ op: 'channel.create', key: L.key + '/' + C.name, name: C.name, parent: catIds[L.key], topic: C.topic, nsfw, overwrites: ow }); order.push({ ref: 'new:' + L.key + '/' + C.name, kind: 'channel', parent: catIds[L.key] }); continue; }
      managed.add(ex.id);
      const ch = {};
      if (ex.parentId !== catIds[L.key]) ch.parent = catIds[L.key];
      if ((ex.topic || '') !== C.topic) ch.topic = C.topic;
      if (!!ex.nsfw !== nsfw) ch.nsfw = nsfw;
      if (owKey(ex.overwrites || []) !== owKey(ow)) ch.overwrites = ow;
      if (Object.keys(ch).length) actions.push({ op: 'channel.update', id: ex.id, name: C.name, ...ch });
      order.push({ ref: ex.id, kind: 'channel', parent: catIds[L.key] });
    }
  }
  // Categorie esistenti non previste: restano intatte (canali, permessi, bot di ticket/log), sotto la nuova struttura.
  // Con archiveOld vengono solo rinominate con il prefisso 🗄️. I canali senza categoria vanno in Archivio. Niente viene cancellato.
  const oldCats = cats.filter((c) => !managed.has(c.id)).sort((a, b) => (a.position || 0) - (b.position || 0));
  for (const c of oldCats) {
    if (opts.archiveOld && !c.name.startsWith('🗄️')) actions.push({ op: 'category.rename', id: c.id, from: c.name, name: ('🗄️ ' + c.name).slice(0, 100) });
    order.push({ ref: c.id, kind: 'category' });
  }
  // Quarantena anche sui canali e sulle categorie esistenti non gestiti: si AGGIUNGE solo un override "In verifica: non vede",
  // il resto dei permessi resta com'è. Un'unica azione raggruppata.
  const qid = roleIds.quarantena; const lock = [];
  for (const c of snap.channels) {
    if (managed.has(c.id) || c.id === catIds.archivio || prot.has(c.id)) continue;
    const has = (c.overwrites || []).some((o) => String(o.id) === String(qid) && (BigInt(o.deny) & P.ViewChannel));
    if (!has) lock.push({ id: c.id, name: c.name });
  }
  if (lock.length) actions.push({ op: 'quarantine.lock', role: qid, channels: lock });
  const inArchive = snap.channels.filter((c) => c.parentId && c.parentId === catIds.archivio).length;
  let room = 50 - inArchive; let skipped = 0;
  for (const c of snap.channels) {
    if (managed.has(c.id) || c.type === 4 || c.parentId || prot.has(c.id)) continue;
    if (room <= 0) { skipped++; continue; }
    actions.push({ op: 'channel.archive', id: c.id, name: c.name, parent: catIds.archivio }); room--;
  }
  if (oldCats.length) warnings.push(oldCats.length + ' categorie esistenti restano intatte sotto la nuova struttura' + (opts.archiveOld ? ', rinominate con 🗄️' : ' (con `archivia_vecchie:True` le rinomino con 🗄️)') + ': ' + oldCats.map((c) => c.name).join(', ').slice(0, 600));
  const protList = [...prot.entries()].filter(([id]) => !LAYOUT.some((L) => L.channels.some((C) => (snap.channels.find((c) => c.id === id) || {}).name === C.name)));
  if (protList.length) warnings.push(protList.length + ' canali protetti lasciati dove sono, con i loro permessi (niente Archivio, niente override anti-raid): ' + protList.map(([id, why]) => '#' + snap.channels.find((c) => c.id === id).name + ' (' + why + ')').join(', ').slice(0, 600));
  if (skipped) warnings.push(skipped + ' canali senza categoria non spostati: Archivio pieno (massimo 50 per categoria).');
  return { actions, warnings, order, ids };
}

function describe(a) {
  switch (a.op) {
    case 'role.create': return '➕ ruolo **' + a.name + '** (#' + a.color.toString(16).padStart(6, '0') + ')';
    case 'role.update': return '🎨 ruolo **' + a.name + '**: colore #' + a.color.toString(16).padStart(6, '0');
    case 'category.create': return '➕ categoria **' + a.name + '**';
    case 'category.rename': return '✏️ categoria "' + a.from + '" → **' + a.name + '**';
    case 'category.perms': return '🔐 permessi categoria **' + a.name + '**';
    case 'channel.create': return '➕ #' + a.name + (a.nsfw ? ' 🔞' : '');
    case 'channel.update': return '🔧 #' + a.name + ': ' + ['parent', 'topic', 'nsfw', 'overwrites'].filter((k) => k in a).map((k) => ({ parent: 'categoria', topic: 'descrizione', nsfw: '18+', overwrites: 'permessi' }[k])).join(', ');
    case 'channel.archive': return '🗄️ #' + a.name + ' → Archivio';
    case 'quarantine.lock': return '🚧 anti-raid: "In verifica" non vede ' + a.channels.length + ' canali/categorie esistenti (aggiunto 1 override, nient\'altro cambia)';
    case 'guide.publish': return '📌 #' + a.channel + ': pubblica e fissa "' + a.title + '"';
    case 'guide.update': return '📝 #' + a.channel + ': aggiorna il messaggio fisso "' + a.title + '"';
    case 'guide.pin': return '📍 #' + a.channel + ': fissa il messaggio "' + a.title + '"';
    case 'automod.create': return '🛡️ AutoMod: crea regola **' + a.name + '**';
    case 'automod.update': return '🛡️ AutoMod: aggiorna regola **' + a.name + '**';
    case 'invite.create': return '🔗 #' + a.channel + ': crea invito pubblico permanente (max_age 0, usi illimitati)';
    case 'invite.reuse': return '🔗 #' + a.channel + ': riusa l\'invito permanente esistente discord.gg/' + a.code + ' e lo salva';
    default: return a.op;
  }
}

function layoutText() {
  return LAYOUT.map((L) => '**' + L.name + '**' + (L.nsfw ? ' (18+, solo Verificato 18+)' : L.access === 'holder' ? ' (solo Holder)' : L.access === 'staff' ? ' (privata)' : '') + '\n' + L.channels.map((c) => '#' + c.name).join(' · ')).join('\n') + '\n**' + ARCHIVE.name + '**\ncanali esistenti non previsti (spostati, non cancellati)';
}

module.exports = { protectedChannels, P, BOT_PERMS, EXTRA_PERMS, INVITE_PERMS, ROLES, LAYOUT, ARCHIVE, ADULT_CATS, RULES_18, plan, describe, layoutText, overwrites, catKey, norm };
