'use strict';
// Registra i comandi slash. Con DISCORD_GUILD_ID li registra solo su quel server (immediato), altrimenti globali.
const { REST, Routes } = require('discord.js');
const cfg = require('./config');
const { DEFS } = require('./commands');
(async () => {
  if (!cfg.token || !cfg.applicationId) { console.error('Servono DISCORD_TOKEN e APPLICATION_ID'); process.exit(1); }
  const rest = new REST({ version: '10' }).setToken(cfg.token);
  const route = cfg.guildId ? Routes.applicationGuildCommands(cfg.applicationId, cfg.guildId) : Routes.applicationCommands(cfg.applicationId);
  const r = await rest.put(route, { body: DEFS });
  console.log('Comandi registrati:', r.map((c) => '/' + c.name).join(' '), cfg.guildId ? '(server)' : '(globali)');
})().catch((e) => { console.error('Registrazione fallita:', e.message); process.exit(1); });
