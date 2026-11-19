'use strict';
// Anti-raid lato bot: account troppo nuovi e picchi di ingressi → ruolo "In verifica" (vede solo #verifica-accesso).
// Logica pura, testabile senza Discord. Funziona solo se l'app ha l'intent "Server Members" attivo nel Developer Portal.
// © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
const DAY = 86400000;

function makeRaidGuard({ minAccountDays = 7, joins = 8, windowS = 60, raidMinutes = 15, now = Date.now } = {}) {
  const recent = new Map(); // guildId -> [timestamp]
  const raidUntil = new Map(); // guildId -> ms
  return {
    minAccountDays,
    // Restituisce { quarantine, reason, raidStarted, autoRelease (ms o null) }
    onJoin(guildId, accountCreatedAt) {
      const t = now();
      const arr = (recent.get(guildId) || []).filter((x) => x > t - windowS * 1000); arr.push(t); recent.set(guildId, arr);
      let raidStarted = false;
      if (arr.length >= joins && !(raidUntil.get(guildId) > t)) raidStarted = true;
      if (arr.length >= joins) raidUntil.set(guildId, t + raidMinutes * 60000);
      const inRaid = raidUntil.get(guildId) > t;
      const ageDays = (t - accountCreatedAt) / DAY;
      const young = ageDays < minAccountDays;
      if (young) return { quarantine: true, reason: 'account creato ' + Math.max(0, Math.floor(ageDays)) + ' giorni fa (minimo ' + minAccountDays + ')', raidStarted, autoRelease: accountCreatedAt + minAccountDays * DAY };
      if (inRaid) return { quarantine: true, reason: 'ingresso durante un picco anomalo (≥' + joins + ' ingressi in ' + windowS + 's)', raidStarted, autoRelease: null };
      return { quarantine: false, raidStarted, autoRelease: null };
    },
    inRaid(guildId) { return raidUntil.get(guildId) > now(); },
  };
}

module.exports = { makeRaidGuard, DAY };
