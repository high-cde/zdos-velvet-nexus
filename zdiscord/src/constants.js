'use strict';
module.exports = {
  DSN_SOL: '35w74RT77BPSYNpmzpvxmR9wu2ihpgzubKy4bkGHR3F4', // $DSN su Solana · Token-2022 · 6 decimali · nessuna pool
  DSN_POLYGON: '0xfc90516a1f736FaC557e09D8853dB80dA192c296',
  VELVET: '2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump', // VELVET ($OV)
  COLORS: { violet: 0x9945ff, green: 0x14f195, cyan: 0x66e3ff, warn: 0xffc93c, fail: 0xff5c7a },
  HEALTH: [
    ['ZSwap', 'https://swap.x-zdos.it/'],
    ['zRoute', 'https://swap.x-zdos.it/zroute/'],
    ['ZQuest', 'https://quest.x-zdos.it/'],
    ['Red Velvet (18+)', 'https://velvet.x-zdos.it/'],
    ['Zlang IDE', 'https://x-zdos.it/ide/'],
    ['x-zdos.it', 'https://x-zdos.it/'],
  ],
  // Permessi minimi (src/club.js BOT_PERMS): Manage Channels (1<<4) + View Channel (1<<10) + Send Messages (1<<11)
  // + Embed Links (1<<14) + Attach Files (1<<15) + Read Message History (1<<16) + Manage Roles (1<<28)
  // + Use Application Commands (1<<31) = 2416036880. Niente Administrator, niente Manage Webhooks (non usati).
  // Invito: in più Manage Guild (1<<5, regole AutoMod) e Pin Messages (1<<51, messaggi guida fissati) = 2251802229722160.
  INVITE_PERMISSIONS: require('./club').INVITE_PERMS,
};
