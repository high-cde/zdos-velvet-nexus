'use strict';
// /setup-server: fotografia del server, piano (src/club.js) e applicazione con discord.js. Idempotente.
// Oltre alla struttura: messaggi guida fissati (src/guides.js), regole AutoMod native (src/automod.js),
// quarantena anti-raid (ruolo "In verifica"), categoria Airdrop VELVET, invito pubblico permanente su #benvenuto. Nulla viene cancellato.
const { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const club = require('./club');
const guides = require('./guides');
const automod = require('./automod');
const inviteLib = require('./invite');

function snapshot(guild) {
  const me = guild.members.me;
  return {
    everyoneId: guild.roles.everyone.id,
    botId: me.id,
    botTopRolePosition: me.roles.highest.position,
    roles: guild.roles.cache.filter((r) => !r.managed && r.id !== guild.roles.everyone.id).map((r) => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, position: r.position })),
    channels: guild.channels.cache.filter((c) => !c.isThread()).map((c) => ({
      id: c.id, name: c.name, type: c.type, parentId: c.parentId || null, nsfw: !!c.nsfw, topic: c.topic || '', position: c.rawPosition,
      overwrites: c.permissionOverwrites ? c.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })) : [],
    })),
  };
}

function resolveOw(ow, map) { return (ow || []).map((o) => ({ id: map(o.id), type: o.type, allow: o.allow, deny: o.deny })).filter((o) => o.id); }

function gateMessage() {
  return {
    embeds: [{
      title: '🔞 Ingresso 18+ ROOM · Velvet Club', color: 0xffd56a,
      description: 'La 18+ ROOM e il Velvet Club sono riservati ad adulti. Premendo il pulsante dichiari la tua data di nascita (non viene salvata) e accetti le regole:\n\n' + club.RULES_18.map((r) => '• ' + r).join('\n') + '\n\nDiscord mostra anche il proprio avviso per i canali con limite di età.',
      footer: { text: 'VelvetHub 18+ by ZDOS1.3 · consenso · safeword ROSSO' },
    }],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('v18:start').setLabel('Ho 18 anni o più · accetto le regole').setStyle(ButtonStyle.Primary).setEmoji('🖤'),
      new ButtonBuilder().setCustomId('v18:leave').setLabel('Esci dalla 18+ ROOM').setStyle(ButtonStyle.Secondary),
    )],
  };
}
function rulesMessage() {
  return { embeds: [{ title: '📜 Regole della 18+ ROOM e del Velvet Club', color: 0xff4ecd, description: club.RULES_18.map((r, i) => (i + 1) + '. ' + r).join('\n') + '\n\nCategorie: ' + club.LAYOUT.find((l) => l.key === 'club').channels.map((c) => '#' + c.name).join(' · '), footer: { text: 'Chi viola le regole perde il ruolo Verificato 18+.' } }] };
}

// Tutti i messaggi fissi gestiti: canale, chiave nello stato, titolo, contenuto.
function allMessages(opts = {}) {
  return [
    { channel: 'ingresso-18', kind: 'gate', title: 'Ingresso 18+ ROOM', payload: gateMessage() },
    { channel: 'regole-18', kind: 'rules', title: 'Regole della 18+ ROOM', payload: rulesMessage() },
    ...guides.build(opts),
  ];
}

const textByName = (guild, n) => guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === n);
const willExist = (name) => club.LAYOUT.some((L) => L.channels.some((c) => c.name === name));

// Piano dei messaggi: guarda lo stato (id + impronta) e, se possibile, il messaggio reale.
async function planMessages(guild, state, opts) {
  const g = state.guild(guild.id); const ids = g.messages || {}; const hashes = g.msgHash || {};
  const out = [];
  for (const m of allMessages(opts)) {
    const ch = textByName(guild, m.channel);
    if (!ch && !willExist(m.channel)) continue;
    const h = guides.hashPayload(m.payload);
    let msg = null;
    if (ch && ids[m.kind]) msg = await ch.messages.fetch({ message: ids[m.kind], force: true }).catch(() => null);
    if (!msg) out.push({ op: 'guide.publish', channel: m.channel, kind: m.kind, title: m.title });
    else if (hashes[m.kind] !== h) out.push({ op: 'guide.update', channel: m.channel, kind: m.kind, title: m.title });
    else if (!msg.pinned) out.push({ op: 'guide.pin', channel: m.channel, kind: m.kind, title: m.title });
  }
  return out;
}

async function ensureMessage(channel, m, state, canPin) {
  const g = state.guild(channel.guild.id); g.messages = g.messages || {}; g.msgHash = g.msgHash || {};
  const h = guides.hashPayload(m.payload);
  let msg = g.messages[m.kind] ? await channel.messages.fetch({ message: g.messages[m.kind], force: true }).catch(() => null) : null;
  let res;
  if (msg) { if (g.msgHash[m.kind] !== h) { await msg.edit(m.payload); res = 'aggiornato'; } else res = 'già allineato'; }
  else { msg = await channel.send(m.payload); g.messages[m.kind] = msg.id; res = 'pubblicato'; }
  g.msgHash[m.kind] = h; state.save();
  if (!msg.pinned) {
    if (canPin) { await msg.pin('setup-server: messaggio guida').then(() => { res += ' e fissato'; }).catch((e) => { res += ' (non fissato: ' + e.message + ')'; }); }
    else res += ' (non fissato: manca il permesso Pin Messages)';
  }
  return res;
}

function permsInfo(guild, memberIntent) {
  const me = guild.members.me;
  const missingExtra = Object.entries(club.EXTRA_PERMS).filter(([, bit]) => !me.permissions.has(bit)).map(([k]) => k);
  const warnings = [];
  if (missingExtra.includes('ManageGuild')) warnings.push('Manca **Manage Guild** (Gestisci server): le regole AutoMod non possono essere lette né create. Riautorizza il bot con il nuovo link di invito.');
  if (missingExtra.includes('PinMessages')) warnings.push('Manca **Pin Messages** (Fissa messaggi): i messaggi guida vengono pubblicati ma non fissati. Riautorizza il bot con il nuovo link di invito.');
  if (!memberIntent) warnings.push('Anti-raid in attesa: attiva "Server Members Intent" nel Discord Developer Portal (Bot → Privileged Gateway Intents). Senza, il bot non vede gli ingressi; il resto funziona.');
  return { missingExtra, warnings, canAutomod: !missingExtra.includes('ManageGuild'), canPin: !missingExtra.includes('PinMessages') };
}

// Invito pubblico permanente su #benvenuto: legge gli inviti del canale (serve Manage Channels, già nei permessi minimi).
async function planInviteFor(guild, state) {
  const ch = textByName(guild, inviteLib.PUBLIC_CHANNEL);
  const g = state.guild(guild.id);
  if (!ch) return { ...inviteLib.planInvite({ stored: g.invite, channelId: null }), channelObj: null };
  const me = guild.members.me;
  const canCreate = ch.permissionsFor(me).has(PermissionFlagsBits.CreateInstantInvite);
  const invites = [...(await ch.fetchInvites()).values()].map(inviteLib.fromDiscord);
  return { ...inviteLib.planInvite({ stored: g.invite, invites, channelId: ch.id, botId: me.id, canCreate }), channelObj: ch };
}

async function ensureInvite(guild, state) {
  const p = await planInviteFor(guild, state);
  const g = state.guild(guild.id);
  if (p.op === 'invite.pending') throw new Error('#' + inviteLib.PUBLIC_CHANNEL + ' non esiste');
  if (p.op === 'invite.blocked') throw new Error('al bot manca Crea invito su #' + inviteLib.PUBLIC_CHANNEL);
  let code = p.code; let how = p.op === 'invite.ok' ? 'già salvato' : 'riusato';
  if (p.op === 'invite.create') {
    const inv = await p.channelObj.createInvite({ maxAge: 0, maxUses: 0, temporary: false, unique: false, reason: 'setup-server: invito pubblico permanente' });
    code = inv.code; how = 'creato';
  }
  if (!g.invite || g.invite.code !== code || g.invite.channelId !== p.channelObj.id) { g.invite = { code, channelId: p.channelObj.id, at: new Date().toISOString() }; state.save(); }
  const url = inviteLib.publicUrl(code);
  console.log('setup-server invito pubblico', how, url, 'server', guild.id);
  return { url, code, how };
}

// Opzioni di protezione per club.plan: aggiunge i canali con un invito permanente pubblico non creato dal bot
// (es. l'invito storico su #collabland-config). Gli inviti del bot / quello salvato su #benvenuto non contano.
async function protectOpts(guild, state, protect = {}) {
  const out = { names: protect.names || [], ids: protect.ids || [], inviteChannelIds: [] }; const warnings = [];
  if (protect.inviteChannels === false) return { protect: out, warnings };
  try {
    const g = state.guild(guild.id); const mine = g.invite && g.invite.code; const botId = guild.members.me.id;
    const invites = [...(await guild.invites.fetch()).values()].map(inviteLib.fromDiscord);
    for (const i of invites) {
      if (Number(i.maxAge) !== 0 || Number(i.maxUses) || i.temporary) continue;
      if (i.code === mine || String(i.inviterId) === String(botId)) continue;
      if (i.channelId && !out.inviteChannelIds.includes(String(i.channelId))) out.inviteChannelIds.push(String(i.channelId));
    }
  } catch (e) { warnings.push('Inviti del server non leggibili (' + e.message + '): protetti solo i canali per nome/ID.'); }
  return { protect: out, warnings };
}

async function planAutomod(guild, modLogId, canAutomod) {
  if (!canAutomod) return { actions: [], warnings: [], skipped: true };
  const rules = await guild.autoModerationRules.fetch();
  return automod.plan([...rules.values()].map(automod.fromDiscord), modLogId);
}

async function apply(guild, state, { maxMax = 200, archiveOld = false, memberIntent = false, minAccountDays = 7, airdropRole = '', protect = {} } = {}) {
  await guild.roles.fetch(); await guild.channels.fetch();
  const snap = snapshot(guild);
  const pr = await protectOpts(guild, state, protect);
  const p = club.plan(snap, { archiveOld, protect: pr.protect });
  p.warnings.push(...pr.warnings);
  const created = {}; const done = []; const errors = [];
  const map = (id) => (typeof id === 'string' && id.startsWith('new:') ? created[id] : id);
  for (const a of p.actions.slice(0, maxMax)) {
    try {
      if (a.op === 'role.create') { const r = await guild.roles.create({ name: a.name, color: a.color, hoist: a.hoist, mentionable: false, permissions: [], reason: 'setup-server z-xSOLANA' }); created['new:' + a.key] = r.id; }
      else if (a.op === 'role.update') await guild.roles.edit(a.id, { color: a.color, hoist: a.hoist, reason: 'setup-server: colori x-zdos.it' });
      else if (a.op === 'category.create') { const c = await guild.channels.create({ name: a.name, type: ChannelType.GuildCategory, permissionOverwrites: resolveOw(a.overwrites, map), reason: 'setup-server' }); created['new:' + a.key] = c.id; }
      else if (a.op === 'category.rename') await guild.channels.edit(a.id, { name: a.name, reason: 'setup-server' });
      else if (a.op === 'category.perms') await guild.channels.edit(a.id, { permissionOverwrites: resolveOw(a.overwrites, map), reason: 'setup-server' });
      else if (a.op === 'channel.create') { const c = await guild.channels.create({ name: a.name, type: ChannelType.GuildText, parent: map(a.parent), topic: a.topic, nsfw: a.nsfw, permissionOverwrites: resolveOw(a.overwrites, map), reason: 'setup-server' }); created['new:' + a.key] = c.id; }
      else if (a.op === 'channel.update') {
        const ch = guild.channels.cache.get(a.id); const edit = {};
        if ('parent' in a) edit.parent = map(a.parent);
        if ('topic' in a) edit.topic = a.topic;
        if ('nsfw' in a) edit.nsfw = a.nsfw;
        if ('overwrites' in a) edit.permissionOverwrites = resolveOw(a.overwrites, map);
        edit.lockPermissions = false;
        await ch.edit({ ...edit, reason: 'setup-server' });
      } else if (a.op === 'channel.archive') await guild.channels.cache.get(a.id).setParent(map(a.parent), { lockPermissions: false, reason: 'setup-server: archiviato, non cancellato' });
      else if (a.op === 'quarantine.lock') {
        // Aggiunge solo l'override del ruolo "In verifica" (deny View Channel): gli altri override restano com'erano.
        const role = map(a.role); let ok = 0; const fail = [];
        for (const c of a.channels) {
          const ch = guild.channels.cache.get(c.id);
          if (!ch) continue;
          try { await ch.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'setup-server: anti-raid, In verifica non vede' }); ok++; } catch (e) { fail.push('#' + c.name); }
        }
        if (fail.length) errors.push('anti-raid: override non impostato su ' + fail.length + ' canali (il bot non li vede o non ha permessi): ' + fail.join(', ').slice(0, 500));
        if (!ok && fail.length) throw new Error('nessun canale aggiornato');
      }
      done.push(a);
    } catch (e) { errors.push(club.describe(a) + ': ' + e.message); }
  }
  // Ordine: categorie nell'ordine del layout, canali nell'ordine previsto dentro ogni categoria.
  try {
    await guild.channels.fetch();
    let ci = 0; const per = {}; const pos = [];
    for (const o of p.order) {
      const id = map(o.ref); if (!id) continue;
      if (o.kind === 'category') pos.push({ channel: id, position: ci++ });
      else { const par = map(o.parent); per[par] = (per[par] || 0); pos.push({ channel: id, position: per[par]++ }); }
    }
    await guild.channels.setPositions(pos);
  } catch (e) { errors.push('ordine canali: ' + e.message); }
  // Messaggi fissi: ingresso con pulsante, regole 18+, guide dei canali principali.
  await guild.channels.fetch();
  const perms = permsInfo(guild, memberIntent);
  const msgs = [];
  for (const m of allMessages({ minAccountDays, airdropRole })) {
    const ch = textByName(guild, m.channel);
    if (ch) { try { msgs.push('#' + m.channel + ': ' + await ensureMessage(ch, m, state, perms.canPin)); } catch (e) { errors.push('#' + m.channel + ': ' + e.message); } }
  }
  // AutoMod nativo (serve Manage Guild).
  const modLog = textByName(guild, 'mod-log');
  let am = { actions: [], warnings: [] };
  if (perms.canAutomod) {
    try {
      am = await planAutomod(guild, modLog ? modLog.id : null, true);
      for (const a of am.actions) {
        try {
          if (a.op === 'automod.create') await guild.autoModerationRules.create(automod.toDiscord(a.rule));
          else await guild.autoModerationRules.edit(a.id, automod.toDiscord(a.rule));
          msgs.push(club.describe(a));
        } catch (e) { errors.push(club.describe(a) + ': ' + e.message); }
      }
    } catch (e) { errors.push('AutoMod: ' + e.message); }
  }
  // Invito pubblico permanente su #benvenuto (creato una volta, poi riusato).
  let invite = null;
  try { invite = await ensureInvite(guild, state); msgs.push('🔗 invito pubblico ' + invite.how + ': ' + invite.url); } catch (e) { errors.push('invito pubblico: ' + e.message); }
  const g = state.guild(guild.id);
  if (g.cursor == null) g.cursor = state.latestEventId != null ? state.latestEventId : 0;
  g.setupAt = new Date().toISOString(); state.save();
  return { planned: p.actions.length + am.actions.length, done: done.length, errors, warnings: [...p.warnings, ...perms.warnings, ...am.warnings], msgs, invite };
}

async function preview(guild, state, { archiveOld = false, memberIntent = false, minAccountDays = 7, airdropRole = '', protect = {} } = {}) {
  const snap = snapshot(guild);
  const pr = await protectOpts(guild, state, protect);
  const p = club.plan(snap, { archiveOld, protect: pr.protect });
  const perms = permsInfo(guild, memberIntent);
  const warnings = [...p.warnings, ...pr.warnings, ...perms.warnings];
  const msgActions = await planMessages(guild, state, { minAccountDays, airdropRole }).catch((e) => { warnings.push('messaggi fissi: ' + e.message); return []; });
  const modLog = textByName(guild, 'mod-log');
  let am = { actions: [], warnings: [] };
  try { am = await planAutomod(guild, modLog ? modLog.id : 'new:staff/mod-log', perms.canAutomod); } catch (e) { warnings.push('AutoMod non leggibile: ' + e.message); }
  if (am.skipped) warnings.push('AutoMod: 5 regole ZDOS (anti-spam, menzioni di massa, link esterni, Telegram solo ufficiale, frasi truffa) verranno create quando il bot avrà Manage Guild.');
  warnings.push(...am.warnings);
  let inv = { op: 'invite.pending', channel: inviteLib.PUBLIC_CHANNEL };
  try { inv = await planInviteFor(guild, state); } catch (e) { warnings.push('invito pubblico non leggibile: ' + e.message); }
  const invAct = (inv.op === 'invite.create' || inv.op === 'invite.reuse') ? [{ op: inv.op, channel: inv.channel, code: inv.code }] : [];
  if (inv.op === 'invite.pending') invAct.push({ op: 'invite.create', channel: inv.channel });
  if (inv.op === 'invite.blocked') warnings.push('Invito pubblico: al bot manca il permesso Crea invito su #' + inv.channel + '.');
  const invite = { op: inv.op, url: inv.code ? inviteLib.publicUrl(inv.code) : null };
  const actions = [...p.actions, ...msgActions, ...am.actions, ...invAct];
  return { actions, warnings, lines: actions.map(club.describe), perms, invite };
}

module.exports = { protectOpts, snapshot, apply, preview, gateMessage, rulesMessage, allMessages, permsInfo, planInviteFor, ensureInvite };
