require("dotenv").config();
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const pino = require("pino");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Client: DiscordClient, GatewayIntentBits } = require("discord.js");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static("public"));

const DB_FILE = "./velvet_db.json";
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : { users: {}, verified: {} };
const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const nodes = { lodgeGroupId: null, novaGroupId: null };
const log = (m) => { console.log(m); io.emit("log", `[${new Date().toLocaleTimeString()}] ${m}`); };

const SECURITY_NOTICE =
  `🖤 *PROTOCOLLO DI SICUREZZA // OUR VELVET & ZDOS* 🖤\n\n` +
  `Sistema di protezione attivo. L accesso e la permanenza nella Loggia sono subordinati a reale autenticazione.\n\n` +
  `📢 *Canale Ufficiale 18+:* https://whatsapp.com/channel/0029Vb9Rbee89inrYLhdem1n\n` +
  `🗝️ *Portale Verifica & Identità $OV:* https://velvet.x-zdos.it\n\n` +
  `👉 Digita \`!forge\` per generare la tua Identità Globale \`$OV\` o \`!velvet\` per i comandi.\n` +
  `_Build what you can prove._ ⚡`;

const discord = new DiscordClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
if (process.env.DISCORD_TOKEN) discord.login(process.env.DISCORD_TOKEN).catch(e => log("Discord err: " + e.message));
const tg = process.env.TELEGRAM_TOKEN ? new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true }) : null;

let sock = null;
let pendingPhone = null;

async function startWA(phoneForPairing = null) {
  if (phoneForPairing) pendingPhone = phoneForPairing;
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && pendingPhone && !sock.authState.creds.registered) {
      try {
        const code = await sock.requestPairingCode(pendingPhone);
        log(`[WA PAIRING] CODICE PRONTO PER ${pendingPhone}: ${code}`);
        io.emit("pairing_code", code);
        pendingPhone = null;
      } catch (e) {
        log(`[WA PAIRING ERR] ${e.message}`);
      }
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      log(`[WA] Connessione chiusa (${code}), riconnessione in 3s...`);
      if (code !== DisconnectReason.loggedOut) setTimeout(() => startWA(), 3000);
    } else if (connection === "open") {
      log("[WA] CONNESSO CON SUCCESSO! Aggancio La Loggia e Nova Community...");

      for (const [k, code] of [["lodgeGroupId", process.env.WA_INVITE_LODGE], ["novaGroupId", process.env.WA_INVITE_NOVA]]) {
        if (!code) continue;
        try {
          const gid = await sock.groupAcceptInvite(code);
          nodes[k] = gid;
          log(`[WA GROUP] Entrato/Agganciato: ${gid}`);
        } catch (_) {}
      }

      const groups = await sock.groupFetchAllParticipating();
      for (const [gid, meta] of Object.entries(groups)) {
        if (meta.subject.includes("Velvet Lodge")) nodes.lodgeGroupId = gid;
        if (meta.subject.includes("Nova Community")) nodes.novaGroupId = gid;
      }

      for (const gid of [nodes.lodgeGroupId, nodes.novaGroupId].filter(Boolean)) {
        await sock.sendMessage(gid, { text: SECURITY_NOTICE });
        log(`[AUTO-FIRE] Messaggio di sicurezza sparato in ${gid}!`);
      }
    }
  });

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action !== "add") return;
    if (id !== nodes.lodgeGroupId && id !== nodes.novaGroupId) return;
    for (const userJid of participants) {
      const num = userJid.split("@")[0];
      const msg =
        `🖤 *BENVENUTO NELLA LOGGIA // AUTENTICAZIONE OBBLIGATORIA* 🖤\n\n` +
        `Benvenuto @${num}. Prima di interagire, dichiara immediatamente:\n` +
        `1️⃣ *ETÀ:* Conferma maggiore età (18+).\n` +
        `2️⃣ *DEVOZIONE:* Rispetto assoluto verso la Loggia e ZDOS.\n` +
        `3️⃣ *ONESTÀ:* Trasparenza totale.\n\n` +
        `🗝️ Scrivi \`!forge\` qui o completa la verifica su https://velvet.x-zdos.it\n` +
        `⚠️ _Chi non si autentica viene rimosso automaticamente._`;
      await sock.sendMessage(id, { text: msg, mentions: [userJid] });
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    if (!jid.endsWith("@g.us")) return;

    const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
    const cmd = body.toLowerCase();
    const sender = msg.key.participant || jid;
    const num = sender.split("@")[0];

    if (cmd === "!sparasicurezza" || cmd === "!lockdown") return sock.sendMessage(jid, { text: SECURITY_NOTICE });
    if (cmd.startsWith("!forge")) {
      if (!db.users[sender]) {
        const hash = crypto.createHash("sha256").update(sender + Date.now()).digest("hex").slice(0, 6).toUpperCase();
        db.users[sender] = { ovId: `OV-${hash}-VELVET`, devotion: 25, status: "INITIATE", wallet: null };
        saveDB();
      }
      const u = db.users[sender];
      return sock.sendMessage(jid, {
        text: `🩸 *IDENTITÀ GLOBALE $OV CREATA* 🩸\n• Soggetto: @${num}\n• Global ID: \`${u.ovId}\`\n• Devozione: *${u.devotion}/100* (${u.status})\n👉 Usa \`!wallet <indirizzo>\` o \`!portal\`.`,
        mentions: [sender]
      });
    }
    if (cmd.startsWith("!wallet ")) {
      const addr = body.slice(8).trim();
      if (!db.users[sender]) db.users[sender] = { ovId: "OV-NEW-VELVET", devotion: 25, status: "INITIATE" };
      db.users[sender].wallet = addr;
      db.users[sender].devotion = Math.min(100, db.users[sender].devotion + 40);
      db.users[sender].status = "DEVOTED";
      saveDB();
      return sock.sendMessage(jid, { text: `💎 *AUTENTICAZIONE $OV COMPLETATA!* Wallet \`${addr.slice(0,6)}...\` verificato. Rango: *DEVOTED*. Digita \`!portal\`.` });
    }
    if (cmd === "!portal") {
      const u = db.users[sender];
      if (!u || u.devotion < 60) return sock.sendMessage(jid, { text: `🔒 Accesso negato. Usa prima \`!forge\` e \`!wallet <indirizzo>\`.` });
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const sig = crypto.createHmac("sha256", process.env.NEXUS_SECRET || "ZDOS2026").update(`${u.ovId}:${exp}`).digest("hex").slice(0, 16);
      const url = `https://velvet.x-zdos.it/?ov_id=${u.ovId}&rank=${u.status}&exp=${exp}&sig=${sig}`;
      await sock.sendMessage(sender, { text: `🖤 *CHIAVE PORTALE DEFINITIVO VELVETHUB*\n\nID: \`${u.ovId}\`\nEntra ora (1h): ${url}` });
      return sock.sendMessage(jid, { text: `🗝️ @${num}, chiave inviata nei tuoi Messaggi Diretti.`, mentions: [sender] });
    }
    if (cmd === "!velvet") {
      return sock.sendMessage(jid, {
        text: `🖤 *COMANDI VELVET PROTOCOL*\n• \`!forge\` — Identità Globale \`$OV\`\n• \`!wallet <indirizzo>\` — Verifica wallet Solana\n• \`!portal\` — Chiave privata per *velvet.x-zdos.it*\n• \`!sparasicurezza\` — Spara avviso sicurezza`
      });
    }
  });
}

app.post("/api/pair", async (req, res) => {
  try {
    let phone = (req.body.phone || "").replace(/[^0-9]/g, "");
    if (!phone) return res.json({ ok: false, error: "Numero mancante" });
    if (phone.length === 10 && phone.startsWith("3")) phone = "39" + phone;
    if (sock) { try { sock.end(); } catch (_) {} }
    fs.rmSync("./auth_info_baileys", { recursive: true, force: true });
    log(`[WA PAIRING] Avvio nuova sessione per ${phone}...`);
    await startWA(phone);
    res.json({ ok: true, code: "ATTENDI 3s NELLA TELEMETRIA SOTTO..." });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/verify-ov/:ovId", (req, res) => {
  const entry = Object.values(db.users).find(u => u.ovId === req.params.ovId);
  if (!entry) return res.status(404).json({ valid: false, error: "Identità  non trovata" });
  res.json({ valid: true, ovId: entry.ovId, status: entry.status, devotion: entry.devotion, wallet: entry.wallet || null });
});

app.post("/api/amplify", async (req, res) => {
  if (req.body.secret !== (process.env.NEXUS_SECRET || "ZDOS2026")) return res.status(403).json({ ok: false });
  const t = req.body.text;
  if (sock && nodes.lodgeGroupId) await sock.sendMessage(nodes.lodgeGroupId, { text: t }).catch(() => {});
  if (sock && nodes.novaGroupId) await sock.sendMessage(nodes.novaGroupId, { text: t }).catch(() => {});
  if (tg && process.env.TELEGRAM_CHANNEL) await tg.sendMessage(process.env.TELEGRAM_CHANNEL, t).catch(() => {});
  res.json({ ok: true });
});

server.listen(process.env.PORT || 8899, () => log("[NEXUS] War Room attiva su porta 8899"));
startWA("393501724159");
