'use strict';
// Bot Discord z-xSOLANA · © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
// Intent: Guilds; in più Server Members (privilegiato) SOLO se l'app lo ha attivo nel Developer Portal, per l'anti-raid.
// Nessuna lettura del contenuto dei messaggi. Risponde solo ai comandi slash e ai pulsanti.
const { Client, GatewayIntentBits, IntentsBitField, ApplicationFlags, Events, MessageFlags, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const { makeRaidGuard, DAY } = require('./antiraid');
const club = require('./club');
const setup = require('./setup');
const velvetLib = require('./velvet');
const { makeRubina, httpPost } = require('./rubina');
const { makeRelay } = require('./relay');
const { makeState } = require('./state');
const cfg = require('./config');
const C = require('./constants');
const { makeSolana } = require('./solana');
const { makeNonceStore } = require('./verify');
const { dispatch } = require('./commands');
const { makeServer } = require('./http');
const { makeAdminServer, listenAdmin } = require('./admin');
const path = require('path');

if (!cfg.token) { console.error('DISCORD_TOKEN mancante: lancia /opt/zdiscord/setup-token.sh'); process.exit(1); }

const sol = makeSolana({ rpcUrls: cfg.rpcUrls });
const store = makeNonceStore({ ttlMs: cfg.nonceTtlMs });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const mask = (s) => (String(s).length > 10 ? String(s).slice(0, 4) + '…' + String(s).slice(-4) : String(s));

async function ensureRole(guild, name) {
  await guild.roles.fetch();
  return guild.roles.cache.find((r) => r.name === name) || guild.roles.create({ name, mentionable: false, hoist: false, permissions: [], reason: 'Ruolo holder z-xSOLANA (verifica con firma wallet)' });
}

async function assignRoles({ guildId, userId, dsn, velvet }) {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  const out = [];
  for (const [has, name] of [[dsn, cfg.roles.dsn], [velvet, cfg.roles.velvet]]) {
    const role = await ensureRole(guild, name);
    if (has && !member.roles.cache.has(role.id)) { await member.roles.add(role, 'holder verificato con firma wallet'); out.push('+' + name); }
    else if (!has && member.roles.cache.has(role.id)) { await member.roles.remove(role, 'saldo zero alla verifica'); out.push('-' + name); }
  }
  console.log('verifica', mask(userId), 'dsn=' + dsn, 'velvet=' + velvet, out.join(' '));
  return out;
}

const deps = {
  rpc: sol.rpc, fetchJson: sol.fetchJson,
  fetchStatus: async (url) => (await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) })).status,
  zdeskJson: async (path) => { const r = await fetch(cfg.zdeskUrl + path, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
  store, verifyUrl: cfg.verifyUrl, roles: cfg.roles,
  tokenBalance: sol.tokenBalance, assignRoles, mints: { dsn: C.DSN_SOL, velvet: C.VELVET },
  discordReady: () => client.isReady(),
};

const state = makeState(cfg.stateDir);
const rubina = makeRubina({ post: httpPost(cfg.ourvelvetUrl) });
const ovJson = async (path, opts = {}) => {
  const r = await fetch(cfg.ourvelvetUrl + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
  let j = null; try { j = await r.json(); } catch (_) { /* */ }
  return { status: r.status, json: j };
};
const raid = makeRaidGuard(cfg.antiRaid);
let memberIntent = false;
const declined = new Map(); // userId -> scadenza: chi si dichiara minorenne non può riprovare per 24 ore (in memoria, nessuna data salvata)

async function roleByKey(guild, key) {
  const R = club.ROLES.find((x) => x.key === key);
  await guild.roles.fetch();
  return guild.roles.cache.find((r) => r.name === R.name) || guild.roles.create({ name: R.name, color: R.color, hoist: R.hoist, mentionable: false, permissions: [], reason: 'ruolo Velvet Club' });
}
const hasRole = (member, key) => member.roles.cache.some((r) => r.name === velvetLib.roleName(key));
const isAdmin = (it) => it.guild && (it.guild.ownerId === it.user.id || (it.memberPermissions && it.memberPermissions.has(PermissionFlagsBits.Administrator)));

async function sendTo(guildId, channelName, payload) {
  const guild = client.guilds.cache.get(guildId); if (!guild) return false;
  const ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === channelName);
  if (!ch) return false;
  try { await ch.send(payload); return true; } catch (e) { console.error('relay invio', channelName, e.message); return false; }
}
const relay = makeRelay({
  fetchFeed: async (after) => { const r = await ovJson('/api/events/feed?after=' + after + '&limit=20'); if (r.status !== 200) throw new Error('feed HTTP ' + r.status); return r.json; },
  state, listGuilds: () => [...client.guilds.cache.keys()], send: sendTo, log: (m) => console.error(m),
});

// Collegamenti Radar: ogni 30 minuti ricontrolla che il profilo esista ancora e non sia nascosto, altrimenti toglie il ruolo.
async function radarSync() {
  for (const [gid, g] of Object.entries(state.data.guilds)) {
    const guild = client.guilds.cache.get(gid); if (!guild || !g.links) continue;
    for (const [uid, links] of Object.entries(g.links)) {
      for (const l of [...links]) {
        try {
          const r = await ovJson('/api/events/radar-link/state?kind=' + l.kind + '&ref=' + encodeURIComponent(l.ref));
          if (r.status !== 200) continue;
          if (!r.json.exists || r.json.hidden) {
            const m = await guild.members.fetch(uid).catch(() => null);
            const role = guild.roles.cache.find((x) => x.name === l.role);
            if (m && role) await m.roles.remove(role, 'profilo Radar rimosso o nascosto').catch(() => {});
            g.links[uid] = g.links[uid].filter((x) => x !== l);
          }
        } catch (_) { /* riprova al prossimo giro */ }
      }
      if (!g.links[uid].length) delete g.links[uid];
    }
  }
  state.save();
}

// ---- Anti-raid: account troppo nuovi / picchi di ingressi → ruolo "In verifica", log in #mod-log ----
const modLog = (guild, payload) => sendTo(guild.id, 'mod-log', { allowedMentions: { parse: [] }, ...payload });
async function quarantineRole(guild) { await guild.roles.fetch(); return guild.roles.cache.find((r) => r.name === velvetLib.roleName('quarantena')) || null; }
const canModerate = (it) => isAdmin(it) || (it.memberPermissions && it.memberPermissions.has(PermissionFlagsBits.ManageRoles));

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (member.user.bot) return;
    const v = raid.onJoin(member.guild.id, member.user.createdTimestamp);
    if (v.raidStarted) await modLog(member.guild, { content: '🚨 **Possibile raid**: troppi ingressi in poco tempo. Per ' + cfg.antiRaid.raidMinutes + ' minuti tutti i nuovi ingressi vanno in verifica.' });
    if (!v.quarantine) return;
    const role = await quarantineRole(member.guild);
    if (!role) return modLog(member.guild, { content: '⚠️ <@' + member.id + '> andrebbe in verifica (' + v.reason + ') ma il ruolo "In verifica" non esiste: lancia /setup-server applica.' });
    await member.roles.add(role, 'anti-raid: ' + v.reason);
    const g = state.guild(member.guild.id); g.quarantine = g.quarantine || {};
    g.quarantine[member.id] = { at: Date.now(), release: v.autoRelease, reason: v.reason }; state.save();
    console.log('antiraid', mask(member.id), v.reason);
    await modLog(member.guild, {
      content: '🚧 <@' + member.id + '> in verifica: ' + v.reason + (v.autoRelease ? ' · sblocco automatico <t:' + Math.floor(v.autoRelease / 1000) + ':R>' : ' · serve l\'approvazione dello staff'),
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mod:ok:' + member.id).setLabel('Approva').setStyle(ButtonStyle.Success))],
    });
  } catch (e) { console.error('antiraid', e.message); }
});

async function releaseMember(guild, uid, why) {
  const role = await quarantineRole(guild);
  const m = await guild.members.fetch(uid).catch(() => null);
  if (m && role && m.roles.cache.has(role.id)) await m.roles.remove(role, why);
  const g = state.guild(guild.id); if (g.quarantine) delete g.quarantine[uid]; state.save();
  return !!m;
}
async function quarantineSweep() {
  for (const [gid, g] of Object.entries(state.data.guilds)) {
    const guild = client.guilds.cache.get(gid); if (!guild || !g.quarantine) continue;
    for (const [uid, q] of Object.entries(g.quarantine)) {
      if (q.release && q.release <= Date.now()) {
        try { const here = await releaseMember(guild, uid, 'anti-raid: account ora abbastanza vecchio'); if (here) await modLog(guild, { content: '✅ <@' + uid + '> sbloccato in automatico (account ora con almeno ' + cfg.antiRaid.minAccountDays + ' giorni).' }); } catch (_) { /* riprova */ }
      } else if (q.at < Date.now() - 30 * DAY) { delete g.quarantine[uid]; }
    }
  }
  state.save();
}

// Rileva se l'app ha l'intent Server Members (verificato o limitato) senza rischiare un login rifiutato.
async function detectMemberIntent() {
  try {
    const r = await fetch('https://discord.com/api/v10/applications/@me', { headers: { authorization: 'Bot ' + cfg.token }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return false;
    const f = Number((await r.json()).flags || 0);
    return !!(f & (ApplicationFlags.GatewayGuildMembers | ApplicationFlags.GatewayGuildMembersLimited));
  } catch (_) { return false; }
}

client.once(Events.ClientReady, (c) => {
  console.log('zdiscord online come', c.user.tag, '· server:', c.guilds.cache.size, '· anti-raid:', memberIntent ? 'attivo' : 'in attesa di Server Members Intent');
  relay.tick().catch(() => {});
  setInterval(() => relay.tick().catch(() => {}), cfg.relayMs);
  setInterval(() => radarSync().catch(() => {}), 30 * 60000);
  setInterval(() => quarantineSweep().catch(() => {}), 10 * 60000);
});

function gateModal() {
  return new ModalBuilder().setCustomId('v18:modal').setTitle('Ingresso 18+ ROOM').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('birth').setLabel('Data di nascita (GG/MM/AAAA) · non salvata').setStyle(TextInputStyle.Short).setMinLength(8).setMaxLength(10).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('accept').setLabel('Scrivi ACCETTO per accettare le regole').setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true)),
  );
}

async function onButton(it) {
  if (it.customId.startsWith('mod:ok:')) {
    if (!canModerate(it)) return it.reply({ content: 'Solo lo staff (Gestisci ruoli) può approvare.', flags: MessageFlags.Ephemeral });
    const uid = it.customId.slice(7);
    const here = await releaseMember(it.guild, uid, 'anti-raid: approvato da staff');
    console.log('antiraid approvato', mask(uid));
    return it.update({ content: (it.message.content || '') + '\n✅ Approvato da <@' + it.user.id + '>' + (here ? '' : ' (non è più nel server)'), components: [], allowedMentions: { parse: [] } });
  }
  if (it.customId === 'v18:start') {
    const until = declined.get(it.user.id);
    if (until && until > Date.now()) return it.reply({ content: 'La 18+ ROOM è riservata ai maggiorenni.', flags: MessageFlags.Ephemeral });
    return it.showModal(gateModal());
  }
  if (it.customId === 'v18:leave') {
    const member = await it.guild.members.fetch(it.user.id);
    const keys = ['v18', 'curioso'];
    for (const k of keys) { const r = it.guild.roles.cache.find((x) => x.name === velvetLib.roleName(k)); if (r && member.roles.cache.has(r.id)) await member.roles.remove(r, 'uscita volontaria dalla 18+ ROOM'); }
    return it.reply({ content: 'Sei uscito dalla 18+ ROOM. Puoi rientrare quando vuoi da #ingresso-18.', flags: MessageFlags.Ephemeral });
  }
}

async function onModal(it) {
  if (it.customId !== 'v18:modal') return;
  const r = velvetLib.checkDeclaration({ birth: it.fields.getTextInputValue('birth'), accept: it.fields.getTextInputValue('accept') });
  if (!r.ok) { if (!r.retry) declined.set(it.user.id, Date.now() + 86400000); return it.reply({ content: r.msg, flags: MessageFlags.Ephemeral }); }
  const member = await it.guild.members.fetch(it.user.id);
  const role = await roleByKey(it.guild, 'v18');
  if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'dichiarazione 18+ e regole accettate');
  console.log('v18', mask(it.user.id), 'ok');
  return it.reply({ content: r.msg, flags: MessageFlags.Ephemeral });
}

let setupBusy = false;
// /setup-server condiviso tra comando slash e terminale (scripts/apply.js via socket locale).
async function runSetup(guild, mode, { archiveOld = false, by = 'terminale VPS' } = {}) {
  await guild.roles.fetch(); await guild.channels.fetch();
  const missing = guild.members.me.permissions.missing(club.BOT_PERMS);
  if (missing.length) return { missing };
  const opts = { archiveOld, memberIntent, minAccountDays: cfg.antiRaid.minAccountDays, airdropRole: cfg.airdropRole, protect: cfg.protect };
  if (mode === 'preview') return { preview: await setup.preview(guild, state, opts) };
  if (setupBusy) throw new Error('un /setup-server applica è già in corso: riprova quando finisce');
  setupBusy = true;
  let r; try { r = await setup.apply(guild, state, opts); } finally { setupBusy = false; }
  console.log('setup-server applicato da', by, '·', r.done + '/' + r.planned, 'modifiche ·', r.errors.length, 'errori', r.invite ? '· invito ' + r.invite.url : '');
  await sendTo(guild.id, 'log-bot', { content: 'setup-server applicato da ' + by + ': ' + r.done + '/' + r.planned + ' modifiche, ' + r.errors.length + ' errori.' + (r.invite ? '\nInvito pubblico (' + r.invite.how + '): ' + r.invite.url : ''), allowedMentions: { parse: [] } });
  return { result: r };
}

async function adminHandle(req) {
  if (!client.isReady()) return { ok: false, error: 'bot non ancora connesso a Discord' };
  const mode = req.mode === 'apply' ? 'apply' : 'preview';
  const guilds = [...client.guilds.cache.values()];
  const guild = req.guildId ? client.guilds.cache.get(String(req.guildId)) : (guilds.length === 1 ? guilds[0] : null);
  if (!guild) return { ok: false, error: req.guildId ? 'server non trovato' : 'il bot è in ' + guilds.length + ' server: indica --guild <id>', guilds: guilds.map((g) => ({ id: g.id, name: g.name })) };
  const out = await runSetup(guild, mode, { archiveOld: !!req.archiveOld, by: 'terminale VPS' });
  const base = { ok: !out.missing, mode, guild: { id: guild.id, name: guild.name }, memberIntent };
  if (out.missing) return { ...base, missing: out.missing };
  if (out.preview) { const p = out.preview; return { ...base, lines: p.lines, warnings: p.warnings, invite: p.invite, missingExtra: p.perms.missingExtra }; }
  const r = out.result; return { ...base, planned: r.planned, done: r.done, errors: r.errors, warnings: r.warnings, msgs: r.msgs, invite: r.invite };
}

async function onVelvetCommand(it) {
  const eph = { flags: MessageFlags.Ephemeral };
  if (it.commandName === 'ingresso-18') return it.reply({ ...setup.gateMessage(), ...eph });
  if (it.commandName === 'setup-server') {
    if (!isAdmin(it)) return it.reply({ content: 'Solo il proprietario del server o un amministratore può usare /setup-server.', ...eph });
    await it.deferReply(eph);
    const archiveOld = !!it.options.getBoolean('archivia_vecchie');
    const mode = it.options.getSubcommand() === 'anteprima' ? 'preview' : 'apply';
    const out = await runSetup(it.guild, mode, { archiveOld, by: '<@' + it.user.id + '>' });
    if (out.missing) return it.editReply({ content: 'Al bot mancano questi permessi: ' + out.missing.join(', ') + '.\nRiautorizzalo con il link di invito aggiornato:\n' + require('./invite').inviteUrl(cfg.applicationId) });
    if (mode === 'preview') {
      const p = out.preview;
      const body = (p.lines.length ? p.lines.join('\n') : 'Nessuna modifica: il server è già allineato.');
      const warn = p.warnings.join('\n');
      const embeds = [
        { title: '/setup-server · anteprima (' + p.lines.length + ' modifiche)', color: 0xffd56a, description: body.slice(0, 4000) + (body.length > 4000 ? '\n…' : '') },
        { title: 'Struttura finale', color: 0x9945ff, description: club.layoutText().slice(0, 4000) },
      ];
      embeds[0].description = (embeds[0].description + '\n\n🔗 Invito pubblico #benvenuto: ' + (p.invite.url || (p.invite.op === 'invite.blocked' ? 'non creabile (permesso mancante)' : 'verrà creato con applica'))).slice(0, 4096);
      if (warn) embeds.push({ title: 'Avvisi', color: 0xffc93c, description: (warn + (p.perms.missingExtra.length ? '\n\nNuovo link di invito (aggiunge ' + p.perms.missingExtra.join(', ') + '):\n' + require('./invite').inviteUrl(cfg.applicationId) : '')).slice(0, 4000) });
      return it.editReply({ embeds });
    }
    const r = out.result;
    return it.editReply({ embeds: [{ title: '/setup-server · applicato', color: r.errors.length ? 0xffc93c : 0x14f195,
      description: ('Modifiche: ' + r.done + '/' + r.planned + '\n' + r.msgs.join('\n') + (r.errors.length ? '\n\n**Errori**\n' + r.errors.join('\n') : '') + (r.warnings.length ? '\n\n**Avvisi**\n' + r.warnings.join('\n') : '') + '\n\nRilanciare il comando è sicuro: applica solo quello che manca.').slice(0, 4000) }] });
  }
  if (it.commandName === 'rubina') {
    const member = it.guild ? await it.guild.members.fetch(it.user.id) : null;
    const allowed = !!(member && velvetLib.isAdultChannel(it.channel) && hasRole(member, 'v18'));
    const text = it.options.getString('messaggio'); const resume = it.options.getBoolean('riprendi');
    const quick = !allowed || !text || /\brosso\b/i.test(text || '');
    if (quick) { const r = await rubina.talk({ userId: it.user.id, text, allowed, resume }); return it.reply({ content: r.content, ...eph }); }
    await it.deferReply();
    const r = await rubina.talk({ userId: it.user.id, text, allowed, resume });
    if (r.ephemeral) { await it.deleteReply().catch(() => {}); return it.followUp({ content: r.content, ...eph }); }
    return it.editReply({ content: r.content, allowedMentions: { parse: [] } });
  }
  if (it.commandName === 'curioso') {
    const member = await it.guild.members.fetch(it.user.id);
    if (!hasRole(member, 'v18')) return it.reply({ content: 'Prima entra nella 18+ ROOM da #ingresso-18.', ...eph });
    const role = await roleByKey(it.guild, 'curioso');
    if (member.roles.cache.has(role.id)) { await member.roles.remove(role, 'opt-out Curioso'); return it.reply({ content: 'Ruolo Curioso tolto.', ...eph }); }
    await member.roles.add(role, 'opt-in Curioso'); return it.reply({ content: 'Ora sei **Curioso**. Usa di nuovo /curioso per toglierlo.', ...eph });
  }
  if (it.commandName === 'radar-collega') {
    await it.deferReply(eph);
    const member = await it.guild.members.fetch(it.user.id);
    if (!hasRole(member, 'v18')) return it.editReply('Prima entra nella 18+ ROOM da #ingresso-18.');
    const kind = it.options.getString('tipo');
    const body = { kind, token: it.options.getString('token'), handle: it.options.getString('handle') || undefined, fedele_id: it.options.getInteger('id') || undefined };
    if (kind === 'mistress' && !body.handle) return it.editReply('Per Mistress/Master serve anche l\'handle X del profilo.');
    if (kind === 'fedele' && !body.fedele_id) return it.editReply('Per Fedele serve anche il numero (id) che ti ha dato il Radar.');
    const key = 'dc-' + require('crypto').createHash('sha256').update('zdiscord:' + it.user.id).digest('hex').slice(0, 16);
    const r = await ovJson('/api/events/radar-link/check', { method: 'POST', body: JSON.stringify(body), headers: { 'x-real-ip': key } });
    if (r.status !== 200) return it.editReply((r.json && r.json.detail) || 'Verifica non riuscita.');
    if (r.json.hidden) return it.editReply('Il profilo è nascosto sul Radar: niente ruolo finché non torna visibile.');
    const rk = r.json.role === 'Master' ? 'master' : r.json.role === 'Fedele' ? 'fedele' : 'mistress';
    const role = await roleByKey(it.guild, rk);
    await member.roles.add(role, 'Radar della Carne: profilo verificato');
    const g = state.guild(it.guild.id); g.links = g.links || {};
    g.links[it.user.id] = (g.links[it.user.id] || []).filter((x) => !(x.kind === kind && x.ref === r.json.ref)).concat([{ kind, ref: r.json.ref, role: role.name }]);
    state.save();
    return it.editReply('Collegato: ruolo **' + role.name + '**. Il token non viene salvato; se cancelli o nascondi il profilo sul Radar il ruolo viene tolto. Per scollegare: /radar-scollega.');
  }
  if (it.commandName === 'radar-scollega') {
    const member = await it.guild.members.fetch(it.user.id);
    const g = state.guild(it.guild.id); const links = (g.links && g.links[it.user.id]) || [];
    for (const l of links) { const role = it.guild.roles.cache.find((x) => x.name === l.role); if (role && member.roles.cache.has(role.id)) await member.roles.remove(role, 'scollegato dal Radar'); }
    if (g.links) delete g.links[it.user.id]; state.save();
    return it.reply({ content: links.length ? 'Scollegato: ruoli Radar tolti.' : 'Nessun collegamento Radar attivo.', ...eph });
  }
}
const VELVET_CMDS = new Set(['setup-server', 'rubina', 'ingresso-18', 'curioso', 'radar-collega', 'radar-scollega']);

client.on(Events.InteractionCreate, async (it) => {
  try {
    if (it.isButton()) return await onButton(it);
    if (it.isModalSubmit()) return await onModal(it);
  } catch (e) {
    console.error('interazione', it.customId, e.message);
    if (!it.replied && !it.deferred) await it.reply({ content: 'Errore temporaneo, riprova tra poco.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (!it.isChatInputCommand()) return;
  if (VELVET_CMDS.has(it.commandName)) {
    if (!it.guild) return it.reply({ content: 'Usa questo comando dentro il server.', flags: MessageFlags.Ephemeral }).catch(() => {});
    try { return await onVelvetCommand(it); } catch (e) {
      console.error('comando', it.commandName, e.message);
      const msg = { content: 'Errore temporaneo, riprova tra poco.' };
      if (it.deferred || it.replied) await it.editReply(msg).catch(() => {}); else await it.reply({ ...msg, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
  }
  const ctx = { guildId: it.guildId, userId: it.user.id, options: { mint: it.options.getString('mint') } };
  try {
    const eph = ['verifica', 'radar'].includes(it.commandName);
    await it.deferReply(eph ? { flags: MessageFlags.Ephemeral } : {});
    const r = await dispatch(it.commandName, ctx, deps);
    await it.editReply({ content: r.content || undefined, embeds: r.embeds || [] });
  } catch (e) {
    console.error('comando', it.commandName, e.message);
    const msg = { content: 'Errore temporaneo, riprova tra poco.' };
    if (it.deferred || it.replied) await it.editReply(msg).catch(() => {}); else await it.reply({ ...msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

deps.relayStatus = () => ({ setupGuilds: Object.keys(state.data.guilds).filter((g) => state.data.guilds[g].setupAt).length, latestEventId: state.latestEventId });
makeServer(deps).listen(cfg.port, cfg.host, () => console.log('API verifica su', cfg.host + ':' + cfg.port));
if (cfg.stateDir) {
  const sockPath = path.join(cfg.stateDir, 'admin.sock');
  listenAdmin(makeAdminServer(adminHandle), sockPath, () => console.log('socket admin locale su', sockPath));
}
(async () => {
  memberIntent = await detectMemberIntent();
  if (memberIntent) client.options.intents = new IntentsBitField([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]).freeze();
  await client.login(cfg.token);
})().catch((e) => { console.error('login', e.message); process.exit(1); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { client.destroy(); process.exit(0); });
