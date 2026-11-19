'use strict';
// Stato persistente minimo in STATE_DIR/state.json (systemd StateDirectory=zdiscord → /var/lib/zdiscord).
// Contiene: id dei messaggi fissi, cursore eventi per server, collegamenti Radar (tipo + riferimento pubblico, MAI token).
const fs = require('fs');
const path = require('path');
function makeState(dir) {
  const file = dir ? path.join(dir, 'state.json') : null;
  let data = { guilds: {} };
  if (file) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')); data.guilds = data.guilds || {}; } catch (_) { /* nuovo */ } }
  const st = {
    latestEventId: null,
    get data() { return data; },
    guild(id) { return (data.guilds[id] = data.guilds[id] || {}); },
    save() {
      if (!file) return;
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
  return st;
}
module.exports = { makeState };
