'use strict';
// Link di invito OAuth del bot + invito pubblico permanente del server (canale #benvenuto), idempotente.
// © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
const C = require('./constants');
const PUBLIC_CHANNEL = 'benvenuto';

function inviteUrl(appId) {
  return 'https://discord.com/oauth2/authorize?client_id=' + encodeURIComponent(appId) + '&scope=bot%20applications.commands&permissions=' + C.INVITE_PERMISSIONS.toString();
}
const publicUrl = (code) => 'https://discord.gg/' + code;

// Permanente = senza scadenza (max_age 0), usi illimitati, non temporaneo (non espelle chi esce senza ruolo).
const isPermanent = (i, channelId) => i && String(i.channelId) === String(channelId) && Number(i.maxAge) === 0 && !Number(i.maxUses) && !i.temporary;

/**
 * Logica pura. stored: { code, channelId } da state.json; invites: inviti del canale [{ code, channelId, maxAge, maxUses, temporary, inviterId }].
 * Restituisce { op: 'invite.ok' | 'invite.reuse' | 'invite.create' | 'invite.blocked' | 'invite.pending', code?, channel }.
 * Priorità: invito salvato ancora valido → invito permanente creato dal bot → qualsiasi invito permanente del canale → nuovo.
 */
function planInvite({ stored, invites, channelId, botId, canCreate }) {
  const channel = PUBLIC_CHANNEL;
  if (!channelId) return { op: 'invite.pending', channel };
  const list = (invites || []).filter((i) => isPermanent(i, channelId));
  if (stored && stored.code && list.some((i) => i.code === stored.code)) return { op: 'invite.ok', code: stored.code, channel };
  const mine = list.find((i) => botId && String(i.inviterId) === String(botId));
  const any = mine || list[0];
  if (any) return { op: 'invite.reuse', code: any.code, channel };
  return canCreate ? { op: 'invite.create', channel } : { op: 'invite.blocked', channel };
}

const fromDiscord = (i) => ({ code: i.code, channelId: i.channelId || (i.channel && i.channel.id), maxAge: i.maxAge, maxUses: i.maxUses, temporary: !!i.temporary, inviterId: i.inviterId || (i.inviter && i.inviter.id) || null });

if (require.main === module) console.log(inviteUrl(process.argv[2] || process.env.APPLICATION_ID || ''));
module.exports = { inviteUrl, publicUrl, planInvite, isPermanent, fromDiscord, PUBLIC_CHANNEL };
