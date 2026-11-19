'use strict';
// Velvet Club: ingresso 18+ (dichiarazione di età + regole), ruoli Curioso e collegamento Radar della Carne.
const club = require('./club');
const AGE_RE = /^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\s*$/;

function ageFrom(dateStr, today = new Date()) {
  const m = AGE_RE.exec(String(dateStr || ''));
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d)) age--;
  if (age < 0 || age > 120) return null;
  return age;
}

// Esito della dichiarazione: niente viene salvato (né data né età), solo il ruolo.
function checkDeclaration({ birth, accept }, today) {
  const age = ageFrom(birth, today);
  if (age == null) return { ok: false, retry: true, msg: 'Data non valida: scrivila come GG/MM/AAAA.' };
  if (String(accept || '').trim().toUpperCase() !== 'ACCETTO') return { ok: false, retry: true, msg: 'Per entrare devi scrivere ACCETTO nel secondo campo.' };
  if (age < 18) return { ok: false, retry: false, msg: 'La 18+ ROOM è riservata ai maggiorenni. Non puoi entrare.' };
  return { ok: true, msg: 'Benvenuto nella 18+ ROOM e nel Velvet Club. 🖤 Leggi #regole-18. Consenso sempre, safeword ROSSO. Discord potrebbe chiederti anche la sua conferma di età per i canali 18+.' };
}

const roleName = (key) => (club.ROLES.find((r) => r.key === key) || {}).name;
const isAdultChannel = (channel) => !!(channel && channel.nsfw && channel.parent && club.ADULT_CATS.includes(club.catKey(channel.parent.name)));

module.exports = { ageFrom, checkDeclaration, roleName, isAdultChannel };
