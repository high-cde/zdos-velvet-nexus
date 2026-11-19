#!/usr/bin/env node
'use strict';
// /setup-server dal terminale del VPS, tramite il bot già in esecuzione (socket locale /var/lib/zdiscord/admin.sock).
// Usa lo stato e la connessione del servizio zdiscord: niente secondo login, niente token letto o stampato da qui.
//   node /opt/zdiscord/scripts/apply.js --dry-run            anteprima (default, non cambia nulla)
//   node /opt/zdiscord/scripts/apply.js --apply              applica (chiede di scrivere APPLICA)
//   node /opt/zdiscord/scripts/apply.js --apply --yes        applica senza domanda (per SSH non interattivo)
//   opzioni: --guild <id>  --archive-old  --json
// © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
const { request } = require('../src/admin');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const sock = process.env.ZDISCORD_SOCK || '/var/lib/zdiscord/admin.sock';
const mode = has('--apply') ? 'apply' : 'preview';
if (has('--apply') && has('--dry-run')) { console.error('Scegli --dry-run oppure --apply.'); process.exit(2); }

async function confirm() {
  if (has('--yes')) return true;
  if (!process.stdin.isTTY) { console.error('Applicazione reale: aggiungi --yes oppure lancia da terminale interattivo.'); return false; }
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question('Applico davvero le modifiche al server Discord? Scrivi APPLICA: ', r)); rl.close();
  return a.trim() === 'APPLICA';
}

(async () => {
  if (mode === 'apply' && !(await confirm())) { console.log('Annullato: nessuna modifica.'); process.exit(1); }
  const r = await request(sock, { mode, guildId: val('--guild'), archiveOld: has('--archive-old') });
  if (has('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  if (!r.ok) { console.error('Errore:', r.error || ('permessi mancanti: ' + (r.missing || []).join(', '))); if (r.guilds) console.error(r.guilds.map((g) => g.id + ' ' + g.name).join('\n')); process.exit(1); }
  const strip = (x) => String(x).replace(/\*\*/g, '');
  console.log('Server:', r.guild.name, '(' + r.guild.id + ') · modalità:', mode === 'apply' ? 'APPLICA' : 'anteprima (dry-run)', '· anti-raid:', r.memberIntent ? 'attivo' : 'in attesa di Server Members Intent');
  if (mode === 'preview') {
    const count = {}; for (const l of r.lines) { const k = strip(l).split(' ')[0]; count[k] = (count[k] || 0) + 1; }
    console.log('\nModifiche previste:', r.lines.length, '·', Object.entries(count).map(([k, n]) => k + ' ' + n).join(' · '));
    for (const l of r.lines) console.log('  ' + strip(l));
    console.log('\nInvito pubblico #benvenuto:', r.invite && r.invite.url ? r.invite.url + ' (' + r.invite.op + ')' : 'verrà creato con --apply');
  } else {
    console.log('\nModifiche:', r.done + '/' + r.planned);
    for (const m of r.msgs || []) console.log('  ' + strip(m));
    if ((r.errors || []).length) { console.log('\nErrori:'); for (const e of r.errors) console.log('  ' + strip(e)); }
    console.log('\nInvito pubblico:', r.invite ? r.invite.url + ' (' + r.invite.how + ')' : 'non disponibile');
  }
  if ((r.warnings || []).length) { console.log('\nAvvisi:'); for (const w of r.warnings) console.log('  ' + strip(w)); }
  process.exit(mode === 'apply' && (r.errors || []).length ? 3 : 0);
})().catch((e) => { console.error('Errore:', e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'socket ' + sock + ' non disponibile: il servizio zdiscord è attivo e aggiornato?' : e.message); process.exit(1); });
