// === VELVET CITY (REAL GAME · PORN · AGI/UMANO) PRESET ===
const VELVET_CITY_STRUCTURE = {
  cityName: "VELVET CITY // REAL GAME · PORN · AGI/UMANO",
  links: {
    hub: "https://velvet.x-zdos.it",
    swap: "https://swap.x-zdos.it",
    quest: "https://quest.x-zdos.it",
    whatsapp: "https://whatsapp.com/channel/0029Vb9Rbee89inrYLhdem1n",
    discord: "https://discord.gg/BcMh6vcpQX",
    tokens: {
      OV: "2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump",
      DSN: "35w74RT77BPSYNpmzpvxmR9wu2ihpgzubKy4bkGHR3F4"
    }
  },
  roles: [
    "Sovereign / Mistress",
    "AGI Core",
    "Umano Verificato",
    "Player / Real Game",
    "VIP Velvet ($OV / $DSN)",
    "Guest 18+"
  ],
  categories: [
    {
      name: "01 · VELVET CITY — GATE 18+",
      nsfw: false,
      channels: [
        { name: "welcome-gate", type: "text", nsfw: false },
        { name: "agi-umano-manifesto", type: "text", nsfw: false },
        { name: "portal-keys", type: "text", nsfw: false }
      ]
    },
    {
      name: "02 · REAL GAME LOUNGE",
      nsfw: false,
      channels: [
        { name: "game-arena", type: "text", nsfw: false },
        { name: "live-drops", type: "text", nsfw: false },
        { name: "Velvet City Arena", type: "voice", nsfw: false }
      ]
    },
    {
      name: "03 · AFTER DARK & EROS 18+",
      nsfw: true,
      channels: [
        { name: "after-dark-lounge", type: "text", nsfw: true },
        { name: "private-requests", type: "text", nsfw: true },
        { name: "After Dark Lounge", type: "voice", nsfw: true }
      ]
    },
    {
      name: "04 · SOVEREIGN OPS & LOGS",
      nsfw: false,
      privateOps: true,
      channels: [
        { name: "nexus-telemetry", type: "text", nsfw: false },
        { name: "audit-logs", type: "text", nsfw: false }
      ]
    }
  ]
};

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./zara_memory.db', (err) => {
    if (err) console.error('[x] Errore database:', err.message);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers
    ]
});

const TOKEN = "MTU3MjMwMTI1MTk4MTYxMTA4OA.G_zI9O.OPRwM6DOPNO3hV-IS54Re52oCakwEbS7-ftEns";
const PORTAL_URL = "https://velvet.x-zdos.it/";
const EMBED_COLOR = 0x580000;

client.once('clientReady', (c) => {
    console.log(`[VELVET CITY AGI-CORE] Connesso come ${c.user.tag}! Protocollo AGI attivo.`);
    c.user.setPresence({
        activities: [{ name: '🔥 Velvet City // AGI & Neural Nodes Active', type: 3 }],
        status: 'dnd',
    });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const command = message.content.trim().toLowerCase();

    // ⚡ COMANDO ATTIVAZIONE UTENTI & BOT AGI (!agibroadcast)
    if (command === '!agibroadcast' || command === '!agi_on' || command === '!attiva_agi') {
        const embed = new EmbedBuilder().setColor(EMBED_COLOR)
            .setTitle(`🧠 ── ATTIVAZIONE AUTOMATICA: RETE AGI & NODI NEURALI ── 👑 🩸`)
            .setDescription(
                '**Protocollo Meat Radar AGI e di sottomissione cibernetica avviato con successo.**\n' +
                'Tutti i nodi autonomi della VPS Contabo, i bot di interazione e le periferiche biologiche sono ora sincronizzati in tempo reale.\n\n' +
                '🤖 **STATO DEI SISTEMI AGI:**\n' +
                '• *K.I.R.A. AI Gateway:* **ONLINE** (Sincronizzato con la Mini App Telegram e VelvetHub)\n' +
                '• *Meat Radar & Token Bridge ($OV / $DSN):* **ATTIVO**\n' +
                '• *Red Room Neural Stream:* **FLUSSO APERTO**\n\n' +
                '✨ *Accedi ai portali ufficiali dell\'ecosistema per gestire i flussi on-chain e le suite.*'
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('VelvetHub Portal').setStyle(ButtonStyle.Link).setURL(PORTAL_URL),
            new ButtonBuilder().setLabel('NFT Gallery 18+').setStyle(ButtonStyle.Link).setURL(PORTAL_URL)
        );

        await message.channel.send({ content: '@everyone ⚡ **TUTTI I BOT E GLI UTENTI AGI SONO STATI ACCESI IN AUTOMATICO DALLA MATRICE!**', embeds: [embed], components: [row] });
        return;
    }
});

client.login(TOKEN);
