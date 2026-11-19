'use strict';
// Configurazione da variabili d'ambiente. Il token sta solo in /etc/zdiscord/bot.env (640), mai nel repo.
const env = process.env;
module.exports = {
  token: env.DISCORD_TOKEN || '',
  applicationId: env.APPLICATION_ID || '',
  guildId: env.DISCORD_GUILD_ID || '',
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 8790),
  verifyUrl: env.VERIFY_URL || 'https://x-zdos.it/discord/verify/',
  zdeskUrl: env.ZDESK_URL || 'http://127.0.0.1:8787',
  rpcUrls: [env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'].filter(Boolean),
  roles: { dsn: env.ROLE_DSN || 'Holder $DSN', velvet: env.ROLE_VELVET || 'Holder VELVET' },
  ourvelvetUrl: env.OURVELVET_URL || 'http://127.0.0.1:8000',
  stateDir: env.STATE_DIRECTORY || env.STATE_DIR || '',
  // Airdrop VELVET: nome (solo testo) del ruolo Discord che conta come verificato. Vuoto = segnaposto "da comunicare".
  airdropRole: env.AIRDROP_VERIFIED_ROLE || '',
  // Canali protetti da /setup-server (niente Archivio, niente override, nessuna modifica): nomi per sottostringa
  // separati da virgola (default "collab", es. Collab.Land), ID espliciti, e i canali con un invito permanente
  // pubblico non creato dal bot (PROTECT_INVITE_CHANNELS=0 per disattivare).
  protect: {
    names: (env.PROTECT_CHANNEL_NAMES != null ? env.PROTECT_CHANNEL_NAMES : 'collab').split(',').map((x) => x.trim()).filter(Boolean),
    ids: (env.PROTECT_CHANNEL_IDS || '').split(',').map((x) => x.trim()).filter(Boolean),
    inviteChannels: env.PROTECT_INVITE_CHANNELS !== '0',
  },
  relayMs: Number(env.RELAY_MS || 60000),
  nonceTtlMs: Number(env.NONCE_TTL_MS || 10 * 60 * 1000),
  // Anti-raid: età minima dell'account (giorni), soglia ingressi in finestra (secondi), durata modalità raid (minuti).
  antiRaid: {
    minAccountDays: Number(env.MIN_ACCOUNT_DAYS || 7),
    joins: Number(env.RAID_JOINS || 8),
    windowS: Number(env.RAID_WINDOW_S || 60),
    raidMinutes: Number(env.RAID_MINUTES || 15),
  },
};
