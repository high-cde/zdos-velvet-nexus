'use strict';
// Relay eventi OurVelvet → Discord. Legge /api/events/feed (eventi pubblici, nessun dato personale),
// pubblica in #velvet-eventi e #annunci dei server configurati con /setup-server, e manda la bozza X in #bozze-x (staff).
// Su X non pubblica mai: la bozza è un link intent che apre l'admin dal proprio account.
const EMOJI = { evento: '🎟️', contest: '🏆', annuncio: '📢', radar: '📡', info: 'ℹ️' };
const TARGETS = { evento: ['velvet-eventi'], contest: ['velvet-eventi', 'annunci'], annuncio: ['annunci'], radar: ['velvet-eventi'], info: ['annunci'] };

function eventEmbed(ev) {
  return { embeds: [{
    title: ((EMOJI[ev.kind] || '🖤') + ' ' + ev.title).slice(0, 256),
    url: ev.url && /^https:\/\//.test(ev.url) ? ev.url : undefined,
    description: [ev.body || '', ev.category_name ? '*' + ev.category_name + '*' : ''].filter(Boolean).join('\n\n').slice(0, 2000) || undefined,
    color: ev.kind === 'contest' ? 0xffd56a : ev.kind === 'radar' ? 0xff4ecd : 0x9945ff,
    footer: { text: 'VelvetHub 18+ · consenso · safeword ROSSO' },
    timestamp: ev.created_at ? new Date(ev.created_at * 1000).toISOString() : undefined,
  }], allowedMentions: { parse: [] } };
}
function draftMessage(ev) {
  const link = ev.x_intent && ev.x_intent.length < 1900 ? '[Apri la bozza su X](' + ev.x_intent + ')' : '(link troppo lungo: copia il testo)';
  return { embeds: [{ title: '✍️ Bozza X · evento #' + ev.id, color: 0x66e3ff, description: '```\n' + String(ev.x_text || '').replace(/```/g, "'''").slice(0, 1500) + '\n```\n' + link + '\nSi apre nel tuo account: la pubblichi tu. Il bot non pubblica su X.' }], allowedMentions: { parse: [] } };
}

function makeRelay({ fetchFeed, state, listGuilds, send, log = () => {} }) {
  let running = false;
  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      const setup = listGuilds().filter((gid) => state.guild(gid).setupAt);
      const cursors = setup.map((gid) => Number(state.guild(gid).cursor || 0));
      const after = cursors.length ? Math.min(...cursors) : 1e12;
      const feed = await fetchFeed(after);
      state.latestEventId = feed.max_id;
      let posted = 0;
      for (const ev of feed.events || []) {
        for (const gid of setup) {
          const g = state.guild(gid);
          if (ev.id <= Number(g.cursor || 0)) continue;
          for (const ch of TARGETS[ev.kind] || ['velvet-eventi']) { if (await send(gid, ch, eventEmbed(ev))) posted++; }
          await send(gid, 'bozze-x', draftMessage(ev));
          g.cursor = ev.id; state.save();
        }
      }
      return { posted, max: feed.max_id };
    } catch (e) { log('relay: ' + e.message); return { error: e.message }; }
    finally { running = false; }
  }
  return { tick };
}
module.exports = { makeRelay, eventEmbed, draftMessage, TARGETS };
