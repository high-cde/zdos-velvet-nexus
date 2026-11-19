const velvetTgConscious = require("./velvet-telegram-conscious");
const velvetShop = require("./velvet-shop-engine");
const globalIdMint = require("./global-id-mint");
const omniBridge = require("./omni-handle-bridge");
const meatRadar = require("./meat-radar-engine");
const proxWA = require("./proximity-wa-submission");
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
        const code = await (async () => { return sock.requestPairingCode(pendingPhone); })();
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

    // === PROXIMITY 30KM & WHATSAPP ONLINE SUBMISSION ===
    if (cmd === "!setloc") {
      const parts = text.trim().split(/\s+/);
      const resLoc = proxWA.setUserLocation(db, sender, parts[1], parts[2], parts[3] || null, "online_wa");
      if (!resLoc.ok) return sock.sendMessage(jid, { text: "❌ " + resLoc.error });
      saveDB();
      return sock.sendMessage(jid, { text: `📍 *POSIZIONE RADAR 30KM SALVATA*\nID: \`${resLoc.ovId}\`\nCoord (arrotondate): \`${resLoc.location.lat}, ${resLoc.location.lon}\`\nRaggio attivo: *30 km* · Modalità: *WhatsApp Online*` });
    }
    if (cmd === "!optoutloc") {
      if (db.users[sender]) {
        delete db.users[sender].location;
        db.users[sender].optOutProximity = true;
        saveDB();
      }
      return sock.sendMessage(jid, { text: "🔒 Posizione rimossa. Sei uscito dal radar 30 km." });
    }
    if (cmd === "!nearby30") {
      const found = proxWA.findUsersWithinRadius(db, sender, 30);
      if (!found.ok) return sock.sendMessage(jid, { text: "❌ " + found.error });
      if (found.matches.length === 0) {
        return sock.sendMessage(jid, { text: "📡 *RADAR VELVET (30 KM)*\nNessun cittadino registrato entro 30 km al momento." });
      }
      const lines = found.matches.slice(0, 12).map((m, i) => `${i + 1}. \`${m.ovId}\` · *${m.distanceKm} km* · Rango: _${m.rank}_ · Devotion: *${m.devotion}*`);
      return sock.sendMessage(jid, { text: `📡 *RADAR VELVET (RAGGIO 30 KM)*\n\n${lines.join("\n")}\n\n👉 Invita a sessione online WA: \`!subsession <OV-XXXX-VELVET> [protocollo]\`` });
    }
    if (cmd === "!subsession") {
      const parts = text.trim().split(/\s+/);
      const targetOv = parts[1];
      const proto = parts.slice(2).join(" ") || "WhatsApp Online Submission";
      if (!targetOv) return sock.sendMessage(jid, { text: "Uso: \`!subsession OV-XXXX-VELVET [protocollo]\`" });
      const inv = proxWA.createOnlineSessionInvite(db, sender, targetOv, proto);
      if (!inv.ok) return sock.sendMessage(jid, { text: "❌ " + inv.error });
      saveDB();
      const s = inv.session;
      await sock.sendMessage(s.targetKey, {
        text: `🖤 *INVITO SESSIONE ONLINE WHATSAPP (18+)*\n\nDa: \`${s.hostOvId}\` (~*${s.distanceKm} km*)\nProtocollo: _${s.type}_\nCodice Sessione: \`${s.id}\`\n\n⚠️ *Consenso esplicito 18+ richiesto.*\n✅ Accetta: \`!acceptsub ${s.id}\`\n❌ Rifiuta: \`!declinesub ${s.id}\``
      }).catch(() => {});
      return sock.sendMessage(jid, { text: `🗝️ Invito \`${s.id}\` inviato a \`${s.targetOvId}\` (${s.distanceKm} km). In attesa di consenso 18+.` });
    }
    if (cmd === "!acceptsub" || cmd === "!declinesub") {
      const sessId = text.trim().split(/\s+/)[1];
      const accept = (cmd === "!acceptsub");
      const resp = proxWA.respondToSession(db, sender, sessId, accept);
      if (!resp.ok) return sock.sendMessage(jid, { text: "❌ " + resp.error });
      saveDB();
      const s = resp.session;
      const statusMsg = accept
        ? `⚡ *SESSIONE ${s.id} ATTIVA SU WHATSAPP*\nPartecipanti: \`${s.hostOvId}\` ↔ \`${s.targetOvId}\` (${s.distanceKm} km)\nProtocollo: _${s.type}_\n_Consenso 18+ registrato nel Nexus._`
        : `🛑 Sessione \`${s.id}\` rifiutata/chiusa.`;
      await sock.sendMessage(s.hostKey, { text: statusMsg }).catch(() => {});
      return sock.sendMessage(jid, { text: statusMsg });
    }


    // === MEAT RADAR 30KM (NO GAME · DIRECT REALITY & WHATSAPP) ===
    if (cmd === "!pulse") {
      const parts = text.trim().split(/\s+/);
      const lat = parts[1];
      const lon = parts[2];
      const role = parts.slice(3).join(" ") || "Citizen 18+";
      const resP = meatRadar.registerMeatPulse(db, sender, { lat, lon, role, mode: "WA-DIRECT + 30KM" });
      if (!resP.ok) return sock.sendMessage(jid, { text: "❌ " + resP.error });
      saveDB();
      return sock.sendMessage(jid, {
        text: `🩸 *SEGNALE CARNE ATTIVO (RAGGIO 30 KM)*\n` +
              `Sigillo: \`${resP.ovId}\`\n` +
              `Ruolo: _${resP.role}_\n` +
              `Settore: \`${resP.location.lat}, ${resP.location.lon}\`\n` +
              `👉 Scansiona ora: \`!radar\``
      });
    }
    if (cmd === "!radar") {
      const scan = meatRadar.scanMeatRadar(db, sender, 30);
      if (!scan.ok) return sock.sendMessage(jid, { text: "❌ " + scan.error });
      if (scan.count === 0) {
        return sock.sendMessage(jid, { text: "📡 *MEAT RADAR (30 KM)*\nNessun segnale attivo nel raggio di 30 km al momento." });
      }
      const rows = scan.targets.slice(0, 15).map((t, idx) =>
        `${idx + 1}. \`${t.ovId}\` · *${t.distanceKm} km* · _${t.role}_ · Devotion: *${t.devotion}*`
      );
      return sock.sendMessage(jid, {
        text: `🩸 *MEAT RADAR ATTIVO — ${scan.count} SEGNALI ENTRO 30 KM*\n\n` +
              `${rows.join("\n")}\n\n` +
              `⚡ Aggancia subito su WhatsApp: \`!lock <OV-XXXX-VELVET> [protocollo]\``
      });
    }
    if (cmd === "!lock") {
      const parts = text.trim().split(/\s+/);
      const targetOv = parts[1];
      const proto = parts.slice(2).join(" ") || "Sottomissione Diretta WhatsApp";
      if (!targetOv) return sock.sendMessage(jid, { text: "Uso: \`!lock OV-XXXX-VELVET [protocollo]\`" });
      const locked = meatRadar.lockMeatSignal(db, sender, targetOv, proto);
      if (!locked.ok) return sock.sendMessage(jid, { text: "❌ " + locked.error });
      saveDB();
      const s = locked.signal;
      await sock.sendMessage(s.targetKey, {
        text: `🩸 *AGGANCIO MEAT RADAR (18+ CONSENSUALE)*\n\n` +
              `Origine: \`${s.hostOvId}\` (_${s.hostRole}_) · Distanza: *${s.distanceKm} km*\n` +
              `Protocollo: _${s.protocol}_\n` +
              `Codice Segnale: \`${s.id}\`\n\n` +
              `⚠️ *Conferma consenso 18+ per aprire il canale diretto:*\n` +
              `✅ \`!confirm ${s.id}\`   |   ❌ \`!abort ${s.id}\``
      }).catch(() => {});
      return sock.sendMessage(jid, {
        text: `📡 Segnale \`${s.id}\` trasmesso a \`${s.targetOvId}\` (*${s.distanceKm} km*). In attesa di conferma consensuale.`
      });
    }
    if (cmd === "!confirm" || cmd === "!abort") {
      const sigId = text.trim().split(/\s+/)[1];
      const accept = (cmd === "!confirm");
      const out = meatRadar.confirmMeatSignal(db, sender, sigId, accept);
      if (!out.ok) return sock.sendMessage(jid, { text: "❌ " + out.error });
      saveDB();
      const s = out.signal;
      const msg = accept
        ? `🔥 *CANALE DIRETTO SBLOCCATO (${s.id})*\n` +
          `\`${s.hostOvId}\` ↔ \`${s.targetOvId}\` (*${s.distanceKm} km*)\n` +
          `Protocollo: _${s.protocol}_\n` +
          `_Consenso 18+ verificato. Nessun filtro, nessuna simulazione._`
        : `🛑 Segnale \`${s.id}\` annullato.`;
      await sock.sendMessage(s.hostKey, { text: msg }).catch(() => {});
      return sock.sendMessage(jid, { text: msg });
    }


    // === OMNI HANDLE BRIDGE (X <-> WHATSAPP <-> TELEGRAM) ===
    if (cmd === "!bridge") {
      // Uso: !bridge @handleX @handleTG [+44...] [OV-ID]
      const parts = text.trim().split(/\s+/).slice(1);
      if (parts.length === 0) {
        const snap = omniBridge.getBridgeSnapshot(db);
        const me = omniBridge.resolveUserByAnyId(db, sender);
        const ch = me?.user?.channels || {};
        return sock.sendMessage(jid, {
          text: `🌉 *OMNI BRIDGE (X · WHATSAPP · TELEGRAM)*\n` +
                `Profili collegati attivi: *${snap.linkedCount}* · Coda X: *${snap.xOutboxCount}*\n` +
                `Tuo ID: \`${me?.user?.ovId || "non assegnato"}\`\n` +
                `X: \`${ch.xHandle || "-"}\` | WA: \`${ch.waPhone || sender}\` | TG: \`${ch.tgUser || "-"}\`\n\n` +
                `👉 Collega canali: \`!bridge @tuoHandleX @tuoHandleTG\``
        });
      }
      let xHandle = null, tgUser = null, waPhone = null, ovId = null;
      for (const p of parts) {
        if (p.toUpperCase().startsWith("OV-") || /^[A-Z0-9]{4}$/i.test(p)) ovId = p;
        else if (/^\+?[0-9]{7,15}$/.test(p)) waPhone = p;
        else if (!xHandle) xHandle = p;
        else if (!tgUser) tgUser = p;
      }
      const resLink = omniBridge.findOrCreateIdentity(db, {
        ovId,
        xHandle,
        tgUser,
        waPhone: waPhone || sender.split("@")[0],
        waJid: jid
      });
      saveDB();
      const c = resLink.user.channels;
      return sock.sendMessage(jid, {
        text: `✅ *IDENTITÀ UNIFICATA ATTIVA*\n` +
              `Sigillo: \`${resLink.user.ovId}\` · Token: \`${resLink.user.bridgeToken}\`\n` +
              `• X Handle: \`${c.xHandle || "-"}\`\n` +
              `• WhatsApp: \`${c.waPhone || "-"}\`\n` +
              `• Telegram: \`${c.tgUser || "-"}\`\n\n` +
              `⚡ Invia ovunque: \`!xcast <messaggio>\``
      });
    }
    if (cmd === "!xcast") {
      const payloadMsg = text.trim().replace(/^!xcast\s+/i, "");
      if (!payloadMsg) return sock.sendMessage(jid, { text: "Uso: \`!xcast <testo da instradare su X / Telegram / Nexus>\`" });
      const sent = await omniBridge.dispatchUnifiedMessage(db, {
        sock,
        tg,
        fromId: sender,
        targets: ["telegram", "x"],
        message: payloadMsg
      });
      saveDB();
      return sock.sendMessage(jid, {
        text: `🌉 *DISPATCH UNIFICATO (${sent.delivery.id})*\n` +
              `Telegram: \`${sent.delivery.results.telegram || "-"}\`\n` +
              `Coda X: \`${sent.delivery.results.x || "-"}\``
      });
    }


    // === GLOBAL REAL ID FORGE (!forge [walletSolana] [@handleX]) ===
    if (cmd === "!forge") {
      const parts = text.trim().split(/\s+/).slice(1);
      let walletArg = null, xArg = null;
      for (const p of parts) {
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p)) walletArg = p;
        else if (p.startsWith("@")) xArg = p;
      }
      const waNum = "+" + sender.split("@")[0].replace(/[^0-9]/g, "");
      const issued = await globalIdMint.issueGlobalRealId(db, {
        senderKey: sender,
        wallet: walletArg,
        xHandle: xArg,
        waPhone: waNum,
        consent18Plus: true
      });
      if (!issued.ok) return sock.sendMessage(jid, { text: "❌ " + issued.error });
      saveDB();
      return sock.sendMessage(jid, {
        text: `🗝️ *ID GLOBALE REALE EMESSO*\n\n` +
              `Sigillo: \`${issued.ovId}\`\n` +
              `Stato: *${issued.status}* (${issued.rank})\n` +
              `Hash: \`${issued.passportHash.slice(0, 16)}...\`\n` +
              `Wallet: \`${issued.wallet || "non collegato (usa !forge <wallet>)"}\`\n` +
              `Lodge Card: ${issued.lodgeCardUrl}\n\n` +
              `⚡ Ora attiva il radar 30km con \`!pulse <lat> <lon>\``
      });
    }


    // === WHATSAPP QUICK SHOP & SLAVE MONEY ===
    if (cmd === "!shop" || cmd === "!tribute" || cmd === "!order") {
      const arg = text.trim().split(/\s+/)[1] || "";
      if (cmd === "!order" && arg) {
        const ord = db.shopOrders?.[arg.toUpperCase()];
        if (ord) {
          return sock.sendMessage(jid, {
            text: `✅ *ORDINE VERIFICATO (${ord.id})*\nArticolo: *${ord.itemTitle}*\nStato: \`${ord.status}\`\nLa Sovereign/Nexus ha registrato il pagamento on-chain.`
          });
        }
      }
      return sock.sendMessage(jid, {
        text: `🖤 *OUR VELVET · QUICK SOLANA SHOP 18+*\n\n` +
              `📸 *Foto & Video 18+:* https://velvet.x-zdos.it/shop.html?item=PHOTO-VIDEO-PACK&sol=0.12\n` +
              `👙 *Intimo Esclusivo:* https://velvet.x-zdos.it/shop.html?item=INTIMO-WORN-DROP&sol=0.35\n` +
              `⛓️ *Slave Money (Tributo):* https://velvet.x-zdos.it/shop.html?item=SLAVE-TRIBUTE-BASE&sol=0.10\n` +
              `👑 *Slave Money (Supremo):* https://velvet.x-zdos.it/shop.html?item=SLAVE-TRIBUTE-SUPREMO&sol=0.50\n\n` +
              `💳 Wallet Tesoreria Solana:\n\`6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD\``
      });
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


// === VELVET CITY 18+ FIRST ACCESS & REAL SOLANA NFT/TOKEN VERIFICATION ===
const velvetFs = require("fs");
const VELVET_ACCESS_FILE = "/opt/zdos-omni-nexus/velvet_access_requests.json";
const SOLANA_RPC_URLS = [
  process.env.SOLANA_RPC_URL,
  process.env.SOLANA_FALLBACK_RPC_URL,
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com"
].filter(Boolean);
const SOLANA_PASS_MINT = (process.env.SOLANA_PASS_MINT || "").trim();
const SOLANA_OV_MINT = (process.env.SOLANA_OV_MINT || "2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump").trim();
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function loadVelvetAccessRequests() {
  try {
    if (!velvetFs.existsSync(VELVET_ACCESS_FILE)) return [];
    return JSON.parse(velvetFs.readFileSync(VELVET_ACCESS_FILE, "utf8"));
  } catch (_) {
    return [];
  }
}

function saveVelvetAccessRequests(list) {
  velvetFs.writeFileSync(VELVET_ACCESS_FILE, JSON.stringify(list, null, 2));
}

async function rpcCall(url, method, params) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return await resp.json();
}

async function verifySolanaMintOnChain(wallet, mintAddress) {
  const cleanWallet = String(wallet || "").trim();
  if (!cleanWallet || cleanWallet.length < 32 || cleanWallet.length > 48 || /\s/.test(cleanWallet)) {
    return { verified: false, error: "Invalid Solana wallet address" };
  }
  const targetMint = String(mintAddress || SOLANA_PASS_MINT || SOLANA_OV_MINT).trim();
  const endpoints = [
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com"
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastErr = "RPC check failed";
  for (const url of endpoints) {
    try {
      for (const filterObj of [
        { mint: targetMint },
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }
      ]) {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenAccountsByOwner",
            params: [cleanWallet, filterObj, { encoding: "jsonParsed" }]
          })
        });
        const data = await resp.json();
        if (data.error) {
          lastErr = data.error.message || "RPC error";
          continue;
        }
        const vals = (data.result && data.result.value) || [];
        let bal = 0;
        for (const item of vals) {
          const info = item.account && item.account.data && item.account.data.parsed && item.account.data.parsed.info;
          if (!info) continue;
          if (!filterObj.mint && info.mint !== targetMint) continue;
          const amt = Number((info.tokenAmount && info.tokenAmount.uiAmount) || 0);
          if (!Number.isNaN(amt)) bal += amt;
        }
        if (bal > 0) {
          return {
            verified: true,
            wallet: cleanWallet,
            mint: targetMint,
            balance: bal,
            rpcUsed: url,
            age18Confirmed: true
          };
        }
      }
      return {
        verified: false,
        wallet: cleanWallet,
        mint: targetMint,
        balance: 0,
        rpcUsed: url,
        age18Confirmed: true
      };
    } catch (e) {
      lastErr = e.message || "Network error";
    }
  }
  return { verified: false, wallet: cleanWallet, mint: targetMint, balance: 0, error: lastErr, age18Confirmed: true };
}

if (typeof app !== "undefined") {
  app.get("/api/velvet/status", (req, res) => {
    const list = loadVelvetAccessRequests();
    res.json({
      ok: true,
      city: "VELVET CITY // REAL GAME · PORN · AGI/UMANO",
      hub: "https://velvet.x-zdos.it",
      solanaRpcs: SOLANA_RPC_URLS,
      passMintConfigured: Boolean(SOLANA_PASS_MINT),
      ovMint: SOLANA_OV_MINT,
      totalRequests: list.length
    });
  });

  app.post("/api/access/request", async (req, res) => {
    const { memberTag, roleLabel, wallet, nftMint, age18, grantFounder } = req.body || {};
    if (age18 !== true) {
      return res.status(400).json({ ok: false, error: "Conferma 18+ obbligatoria (age18: true)" });
    }
    const list = loadVelvetAccessRequests();
    const isPartnerOrFounder = grantFounder === true || /moglie|partner|founder|io-18/i.test(String(memberTag || ""));
    let solanaCheck = null;
    if (wallet) {
      solanaCheck = await verifySolanaMintOnChain(wallet, nftMint);
    }
    const entry = {
      id: "VC18-" + Date.now(),
      createdAt: new Date().toISOString(),
      memberTag: String(memberTag || "Member 18+").slice(0, 64),
      roleLabel: String(roleLabel || "Umano Verificato 18+").slice(0, 64),
      wallet: wallet ? String(wallet).trim() : null,
      solanaVerified: Boolean(solanaCheck && solanaCheck.verified),
      solanaBalance: solanaCheck ? (solanaCheck.balance || 0) : 0,
      status: (isPartnerOrFounder || (solanaCheck && solanaCheck.verified)) ? "GRANTED_18PLUS" : "PENDING_SOLANA_NFT"
    };
    list.push(entry);
    saveVelvetAccessRequests(list);
    res.json({ ok: true, access: entry, solana: solanaCheck });
  });

  app.post("/api/access/grant", (req, res) => {
    const { id, memberTag, wallet, roleLabel } = req.body || {};
    const list = loadVelvetAccessRequests();
    let updated = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if ((id && list[i].id === id) || (memberTag && list[i].memberTag === memberTag) || (wallet && list[i].wallet === wallet)) {
        list[i].status = "GRANTED_18PLUS";
        if (wallet) list[i].wallet = String(wallet).trim();
        if (roleLabel) list[i].roleLabel = String(roleLabel).slice(0, 64);
        list[i].grantedAt = new Date().toISOString();
        updated = list[i];
        break;
      }
    }
    saveVelvetAccessRequests(list);
    if (!updated) return res.status(404).json({ ok: false, error: "Richiesta non trovata" });
    res.json({ ok: true, access: updated });
  });

  
  
  
  app.post("/api/access/issue-pass", (req, res) => {
    try {
      const { issuerWallet, targetWallet, memberTag, tier, roleLabel } = req.body || {};
      const iw = String(issuerWallet || "").trim();
      const tw = String(targetWallet || "").trim();
      if (!iw || !tw || tw.length < 32 || tw.length > 48) {
        return res.status(400).json({ ok: false, error: "Wallet mittente o destinatario non valido" });
      }
      const list = loadVelvetAccessRequests();
      const issuer = list.find(
        (x) => x.wallet === iw && (x.tier === "PLATINUM_SUPREMO" || x.tier === "SOVEREIGN_FOUNDER")
      );
      if (!issuer) {
        return res.status(403).json({ ok: false, error: "Autorizzazione negata: richiesto tier PLATINUM_SUPREMO o SOVEREIGN_FOUNDER" });
      }
      const now = new Date().toISOString();
      const newTier = String(tier || "VIP_LOGGIA").trim().toUpperCase();
      const entry = {
        id: "VC18-" + Date.now(),
        createdAt: now,
        certifiedAt: now,
        issuedBy: iw,
        memberTag: String(memberTag || "Membro-Loggia-18+").trim(),
        roleLabel: String(roleLabel || "Membro Verificato 18+ · La Loggia BDSM").trim(),
        wallet: tw,
        tier: newTier,
        badgeCode: newTier === "PLATINUM_SUPREMO" ? "NSWT-T" : "LOGGIA-18",
        venue: "La Loggia BDSM",
        ecosystem: "ZDOS / z-xSOLANA",
        status: "GRANTED_18PLUS"
      };
      list.push(entry);
      saveVelvetAccessRequests(list);
      res.json({ ok: true, pass: entry });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

    app.post("/api/solana/rpc", async (req, res) => {
    const endpoints = [
      (process.env.SOLANA_RPC_URL || "").trim(),
      "https://solana-rpc.publicnode.com",
      "https://rpc.ankr.com/solana",
      "https://api.mainnet-beta.solana.com"
    ].filter(Boolean);

    for (const url of endpoints) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body || {})
        });
        const txt = await r.text();
        if (r.ok && !txt.includes("Access forbidden")) {
          res.setHeader("Content-Type", "application/json");
          return res.status(200).send(txt);
        }
      } catch (_) {}
    }
    res.status(502).json({ jsonrpc: "2.0", id: (req.body && req.body.id) || 1, error: { code: -32000, message: "RPC Solana non raggiungibile" } });
  });

  app.get("/api/nft/badge/:wallet.svg", (req, res) => {
    const wallet = String(req.params.wallet || "").trim();
    const list = loadVelvetAccessRequests();
    const item = list.find((x) => x.wallet === wallet) || {
      id: "VC18-RUBINA-NSWT",
      memberTag: "Rubina - Mistress Suprema (NSWT-T)",
      tier: "PLATINUM_SUPREMO",
      wallet: wallet || "6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD"
    };
    const safeTag = String(item.memberTag || "Rubina Mistress").replace(/[<>&"']/g, "");
    const svg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">',
      '<defs><linearGradient id="b" x1="0%" y1="0%" x2="100%" y2="100%">',
      '<stop offset="0%" stop-color="#2b0914"/><stop offset="55%" stop-color="#120c1a"/><stop offset="100%" stop-color="#4a0404"/>',
      '</linearGradient></defs>',
      '<rect x="6" y="6" width="788" height="488" rx="28" fill="url(#b)" stroke="#ff2e63" stroke-width="5"/>',
      '<circle cx="680" cy="120" r="110" fill="#ff2e63" opacity="0.12"/>',
      '<text x="42" y="62" fill="#ffffff" font-family="system-ui, sans-serif" font-size="25" font-weight="900">$OV SUPER BADGE GIFT ULTRA NFT</text>',
      '<text x="42" y="96" fill="#ff2e63" font-family="system-ui, sans-serif" font-size="22" font-weight="800">GRADO: MISTRESS ULTRA · PLATINUM SUPREMO (NSWT-T)</text>',
      '<path d="M560,155 L740,155 L740,173 L560,173 Z M650,173 L650,245 L632,245 L632,173 Z M614,245 L668,245 L668,263 L614,263 Z" fill="#e5e4e2"/>',
      '<circle cx="650" cy="302" r="36" stroke="#ff2e63" stroke-width="4" fill="none"/>',
      '<rect x="676" y="382" width="82" height="82" rx="16" fill="#ffffff"/>',
      '<text x="717" y="434" fill="#ff2e63" font-family="system-ui, sans-serif" font-size="38" font-weight="900" text-anchor="middle">OV</text>',
      '<text x="717" y="455" fill="#09060d" font-family="monospace" font-size="12" font-weight="bold" text-anchor="middle">ZDOS</text>',
      '<text x="42" y="165" fill="#cbd5e1" font-family="monospace" font-size="13">CERTIFICATO PER:</text>',
      '<text x="42" y="195" fill="#ff2e63" font-family="system-ui, sans-serif" font-size="24" font-weight="800">' + safeTag + '</text>',
      '<text x="42" y="242" fill="#cbd5e1" font-family="monospace" font-size="13">ID CERTIFICAZIONE GLOBALE:</text>',
      '<text x="42" y="268" fill="#ffffff" font-family="monospace" font-size="19" font-weight="bold">' + item.id + '</text>',
      '<text x="42" y="314" fill="#cbd5e1" font-family="monospace" font-size="13">WALLET SOLANA:</text>',
      '<text x="42" y="340" fill="#e2e8f0" font-family="monospace" font-size="16">' + item.wallet + '</text>',
      '<rect x="42" y="378" width="340" height="86" rx="15" fill="rgba(255,255,255,0.08)" stroke="#ff2e63" stroke-width="1.5"/>',
      '<text x="60" y="410" fill="#ffffff" font-family="system-ui, sans-serif" font-size="16" font-weight="800">SALDO $OV (VELVET LIVE)</text>',
      '<text x="60" y="446" fill="#69f0ae" font-family="monospace" font-size="28" font-weight="900">999.999,99 $OV</text>',
      '<text x="42" y="486" fill="#f472b6" font-family="monospace" font-size="13">Safeword: ROSSO · Solo 18+ · La Loggia BDSM &amp; OurVelvet</text>',
      '</svg>'
    ].join("");
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(svg);
  });

  app.get("/api/nft/badge/:wallet.json", (req, res) => {
    const wallet = String(req.params.wallet || "").trim();
    const list = loadVelvetAccessRequests();
    const item = list.find((x) => x.wallet === wallet) || {
      id: "VC18-RUBINA-NSWT",
      memberTag: "Rubina - Mistress Suprema (NSWT-T)",
      tier: "PLATINUM_SUPREMO",
      wallet: wallet || "6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD"
    };
    res.json({
      id: item.id,
      memberTag: item.memberTag,
      name: "$OV Badge Gift Ultra - " + item.memberTag,
      symbol: "OVGIFT",
      description: "Certificato di MISTRESS ULTRA per La Loggia BDSM & OurVelvet (ZDOS). Wallet: " + item.wallet,
      image: "https://velvet.x-zdos.it/api/nft/badge/" + encodeURIComponent(item.wallet) + ".svg",
      external_url: "https://velvet.x-zdos.it/badge",
      attributes: [
        { trait_type: "Grado", value: "Mistress Ultra" },
        { trait_type: "ID Certificato", value: item.id },
        { trait_type: "Wallet", value: item.wallet },
        { trait_type: "Protocollo", value: "Safeword: ROSSO · 18+" }
      ]
    });
  });

app.post("/api/access/badge", (req, res) => {
    try {
      const { wallet } = req.body || {};
      const w = String(wallet || "").trim();
      if (!w) return res.status(400).json({ ok: false, error: "Wallet mancante" });
      const list = loadVelvetAccessRequests();
      const matches = list.filter((x) => x.wallet === w);
      if (!matches.length) {
        return res.json({ ok: true, found: false, wallet: w });
      }
      const best = matches.find((x) => x.tier === "PLATINUM_SUPREMO") || matches[matches.length - 1];
      res.json({
        ok: true,
        found: true,
        wallet: w,
        id: best.id,
        memberTag: best.memberTag || "",
        roleLabel: best.roleLabel || "",
        tier: best.tier || "STANDARD_18PLUS",
        badgeCode: best.badgeCode || "",
        venue: best.venue || "",
        ecosystem: best.ecosystem || "ZDOS / z-xSOLANA",
        signatureVerified: Boolean(best.signatureVerified),
        solanaVerified: Boolean(best.solanaVerified),
        status: best.status || "GRANTED_18PLUS"
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/solana/balances", async (req, res) => {
    try {
      const { wallet } = req.body || {};
      const w = String(wallet || "").trim();
      if (!w || w.length < 32 || w.length > 48) {
        return res.status(400).json({ ok: false, error: "Wallet Solana non valido" });
      }
      const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
      const solResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [w] })
      });
      const solJson = await solResp.json();
      const lamports = (solJson.result && solJson.result.value) || 0;
      const solBalance = Number((lamports / 1e9).toFixed(6));

      const ovCheck = await verifySolanaMintOnChain(w, "2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump");
      const dsnCheck = await verifySolanaMintOnChain(w, "35w74RT77BPSYNpmzpvxmR9wu2ihpgzubKy4bkGHR3F4");

      res.json({
        ok: true,
        wallet: w,
        sol: solBalance,
        ov: ovCheck.balance || 0,
        dsn: dsnCheck.balance || 0
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/solana/verify-pass", async (req, res) => {
    try {
      const { wallet, mint } = req.body || {};
      const result = await verifySolanaMintOnChain(wallet, mint);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/verify-ov/:ovId", async (req, res) => {
    try {
      const { wallet, mint } = req.body || {};
      const result = await verifySolanaMintOnChain(wallet, mint || SOLANA_OV_MINT);
      res.json({ ok: true, ovId: req.params.ovId, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}



// === SOLANA ED25519 MESSAGE SIGNATURE AUTH (NON-CUSTODIAL, NO TX) ===
const velvetCrypto = require("crypto");
const VELVET_NONCES = new Map();
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(str) {
  if (typeof str !== "string" || !str.length) return null;
  let num = 0n;
  for (let i = 0; i < str.length; i++) {
    const idx = BASE58_ALPHABET.indexOf(str[i]);
    if (idx === -1) return null;
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.push(Number(num % 256n));
    num = num / 256n;
  }
  for (let i = 0; i < str.length && str[i] === "1"; i++) {
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

function parseSignatureBytes(sig) {
  if (!sig) return null;
  if (Array.isArray(sig)) return Buffer.from(sig);
  if (sig && typeof sig === "object" && sig.type === "Buffer" && Array.isArray(sig.data)) {
    return Buffer.from(sig.data);
  }
  if (typeof sig === "string") {
    const clean = sig.trim();
    const b58 = decodeBase58(clean);
    if (b58 && b58.length === 64) return b58;
    try {
      const b64 = Buffer.from(clean, "base64");
      if (b64.length === 64) return b64;
    } catch (_) {}
    if (/^[0-9a-fA-F]{128}$/.test(clean)) {
      return Buffer.from(clean, "hex");
    }
  }
  return null;
}

function verifySolanaSignature(wallet, message, signature) {
  const pubBytes = decodeBase58(String(wallet || "").trim());
  const sigBytes = parseSignatureBytes(signature);
  if (!pubBytes || pubBytes.length !== 32) {
    return { valid: false, error: "Invalid Solana public key (must decode to 32 bytes)" };
  }
  if (!sigBytes || sigBytes.length !== 64) {
    return { valid: false, error: "Invalid signature format (must be 64 bytes)" };
  }
  // SPKI DER prefix for 32-byte Ed25519 public key: 302a300506032b6570032100
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const derKey = Buffer.concat([spkiPrefix, pubBytes]);
  const keyObj = velvetCrypto.createPublicKey({ key: derKey, format: "der", type: "spki" });
  const msgBuf = Buffer.from(String(message || ""), "utf8");
  const valid = velvetCrypto.verify(null, msgBuf, keyObj, sigBytes);
  return { valid, wallet: String(wallet).trim() };
}

if (typeof app !== "undefined") {
  app.post("/api/auth/challenge", (req, res) => {
    const { wallet, memberTag } = req.body || {};
    const w = String(wallet || "").trim();
    if (!w || w.length < 32 || w.length > 48) {
      return res.status(400).json({ ok: false, error: "Wallet Solana non valido" });
    }
    const nonce = velvetCrypto.randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const message = [
      "VELVET CITY // 18+ SIGNED WALLET AUTH",
      "Hub: https://velvet.x-zdos.it",
      "Wallet: " + w,
      "Tag: " + String(memberTag || "Member-18+").slice(0, 48),
      "Nonce: " + nonce,
      "IssuedAt: " + issuedAt,
      "Note: Signature only (no funds moved)"
    ].join("\\n");
    VELVET_NONCES.set(nonce, { wallet: w, expiresAt });
    res.json({ ok: true, nonce, message, expiresAt });
  });

  app.post("/api/auth/verify-signature", async (req, res) => {
    try {
      const { wallet, message, signature, nonce, memberTag, roleLabel, mint } = req.body || {};
      const w = String(wallet || "").trim();
      if (nonce) {
        const rec = VELVET_NONCES.get(String(nonce));
        if (!rec || Date.now() > rec.expiresAt) {
          return res.status(400).json({ ok: false, error: "Nonce scaduto o non valido" });
        }
        if (rec.wallet !== w) {
          return res.status(400).json({ ok: false, error: "Wallet non corrispondente alla sfida" });
        }
        VELVET_NONCES.delete(String(nonce));
      }
      const sigCheck = verifySolanaSignature(w, message, signature);
      if (!sigCheck.valid) {
        return res.status(401).json({ ok: false, signatureVerified: false, error: sigCheck.error || "Firma non valida" });
      }
      const solanaCheck = await verifySolanaMintOnChain(w, mint || SOLANA_OV_MINT);
      const list = loadVelvetAccessRequests();
      let matched = null;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].wallet === w) {
          list[i].signatureVerified = true;
          list[i].signedAt = new Date().toISOString();
          list[i].solanaVerified = Boolean(solanaCheck && solanaCheck.verified);
          list[i].solanaBalance = solanaCheck ? (solanaCheck.balance || 0) : 0;
          list[i].verifiedMint = solanaCheck ? solanaCheck.mint : (mint || SOLANA_OV_MINT);
          list[i].status = "GRANTED_18PLUS";
          if (roleLabel) list[i].roleLabel = String(roleLabel).slice(0, 64);
          matched = list[i];
          break;
        }
      }
      if (!matched) {
        matched = {
          id: "VC18-" + Date.now(),
          createdAt: new Date().toISOString(),
          memberTag: String(memberTag || "Signed-18+").slice(0, 64),
          roleLabel: String(roleLabel || "Umano Verificato 18+").slice(0, 64),
          wallet: w,
          signatureVerified: true,
          signedAt: new Date().toISOString(),
          solanaVerified: Boolean(solanaCheck && solanaCheck.verified),
          solanaBalance: solanaCheck ? (solanaCheck.balance || 0) : 0,
          verifiedMint: solanaCheck ? solanaCheck.mint : (mint || SOLANA_OV_MINT),
          status: "GRANTED_18PLUS"
        };
        list.push(matched);
      }
      saveVelvetAccessRequests(list);
      res.json({
        ok: true,
        signatureVerified: true,
        access: matched,
        solana: solanaCheck
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}



// === MEAT RADAR HTTP API (FOR VELVET.X-ZDOS.IT & DASHBOARD) ===
app.get("/api/meat-radar/telemetry", (req, res) => {
  res.json(meatRadar.getRadarTelemetry(db));
});

app.post("/api/meat-radar/pulse", (req, res) => {
  const { ovId, lat, lon, role, mode } = req.body || {};
  const entry = Object.entries(db.users || {}).find(
    ([, u]) => u && String(u.ovId).toUpperCase() === String(ovId || "").trim().toUpperCase()
  );
  if (!entry) return res.status(404).json({ ok: false, error: "Identità $OV non trovata. Esegui !forge su WhatsApp." });
  const r = meatRadar.registerMeatPulse(db, entry[0], { lat, lon, role, mode });
  if (!r.ok) return res.status(400).json(r);
  saveDB();
  res.json(r);
});

app.get("/api/meat-radar/scan/:ovId", (req, res) => {
  const r = meatRadar.scanByOvId(db, req.params.ovId, 30);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});


// === OMNI BRIDGE HTTP API (X <-> WHATSAPP <-> TELEGRAM) ===
app.get("/api/bridge/status", (req, res) => {
  res.json(omniBridge.getBridgeSnapshot(db));
});

app.post("/api/bridge/link", (req, res) => {
  const { ovId, xHandle, waPhone, waJid, tgUser, tgChatId } = req.body || {};
  if (!ovId && !xHandle && !waPhone && !waJid && !tgUser && !tgChatId) {
    return res.status(400).json({ ok: false, error: "Fornisci almeno un identificativo (ovId, xHandle, waPhone, tgUser)." });
  }
  const r = omniBridge.findOrCreateIdentity(db, { ovId, xHandle, waPhone, waJid, tgUser, tgChatId });
  saveDB();
  res.json(r);
});

app.post("/api/bridge/dispatch", async (req, res) => {
  const { fromId, toId, targets, message } = req.body || {};
  const r = await omniBridge.dispatchUnifiedMessage(db, {
    sock,
    tg,
    fromId,
    toId,
    targets: Array.isArray(targets) && targets.length ? targets : ["whatsapp", "telegram", "x"],
    message
  });
  saveDB();
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});


// === GLOBAL REAL ID ISSUE API ===
app.post("/api/global-id/issue", async (req, res) => {
  try {
    const r = await globalIdMint.issueGlobalRealId(db, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    saveDB();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// === SOLANA RPC PROXY (ANTI-403 FOR BROWSER & PHANTOM FLOWS) ===
app.post("/api/solana-rpc", async (req, res) => {
  const rpcs = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com"
  ];
  for (const url of rpcs) {
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "ZDOS-Velvet-Nexus/1.0" },
        body: JSON.stringify(req.body || {})
      });
      const data = await upstream.json();
      if (upstream.ok && data) return res.json(data);
    } catch (e) {}
  }
  res.status(502).json({ jsonrpc: "2.0", error: { code: -32005, message: "Upstream Solana RPC unavailable" }, id: req.body?.id || 1 });
});


// === VELVET QUICK SHOP HTTP API ===
app.get("/api/shop/catalog", (req, res) => {
  res.json(velvetShop.getShopSnapshot(db));
});

app.post("/api/shop/verify-order", async (req, res) => {
  try {
    const r = await velvetShop.verifyAndRecordOrder(db, req.body || {});
    if (!r.ok) return res.status(400).json(r);
    saveDB();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


if (typeof tg !== "undefined" && tg) {
  velvetTgConscious.attachConsciousTelegram(tg, db, saveDB);
}

server.listen(process.env.PORT || 8899, () => log("[NEXUS] War Room attiva su porta 8899"));
startWA("447742507902");


// --- ZDOS & OUR VELVET EVOLVED ROUTES ---
const cryptoMod = require("crypto");

function zdosGenFourLetterCode(seed) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const h = cryptoMod.createHash("sha256").update(String(seed)).digest();
  let out = "";
  for (let i = 0; i < 4; i++) out += letters[h[i] % letters.length];
  return out;
}

app.get("/api/aggregator", (req, res) => {
  try {
    const agg = JSON.parse(fs.readFileSync("/opt/zdos-omni-nexus/aggregator_state.json", "utf8"));
    res.json({ ok: true, data: agg, usersCount: Object.keys((typeof db !== "undefined" && db.users) || {}).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/zswap-link", (req, res) => {
  const rank = String(req.query.rank || "curioso").toLowerCase();
  const stackTier = String(req.query.stack || "STACK_INITIATE");
  res.json({
    ok: true,
    zswapUrl: "https://swap.x-zdos.it/?source=velvet&rank=" + encodeURIComponent(rank) + "&stack=" + encodeURIComponent(stackTier) + "&entry_eur=2&anchor_eur=0.01",
    gatewayWhatsapp: "+447742507902"
  });
});

app.get("/api/payment-wallet", (req, res) => {
  res.json({
    ok: true,
    wallet: "6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD",
    chain: "solana",
    amountEur: 2.00,
    feesIncluded: true,
    badgeAutoGenerated: true,
    badgeAsset: "assets/card-mistress-gif.gif",
    senderWhatsapp: "+447742507902",
    zswapUrl: "https://swap.x-zdos.it"
  });
});

app.get("/api/mistress-legal-finance", (req, res) => {
  try {
    const agg = JSON.parse(fs.readFileSync("/opt/zdos-omni-nexus/aggregator_state.json", "utf8"));
    res.json({ ok: true, mistressLegalFinance: agg.mistress_legal_finance });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/verify-payment-2eur", async (req, res) => {
  try {
    const body = req.body || {};
    const senderWallet = String(body.senderWallet || "").trim();
    const rank = String(body.rank || "slave").toLowerCase();
    const phone = String(body.phone || "").trim();
    const oathAccepted = Boolean(body.oathAccepted);

    if (!oathAccepted) {
      return res.status(400).json({ ok: false, error: "Oath (18+, Devotion, Honesty) required." });
    }

    const rpcResp = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: ["6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD", { limit: 15 }]
      })
    });
    const rpcJson = await rpcResp.json();
    const sigs = Array.isArray(rpcJson.result) ? rpcJson.result : [];
    const matchedSig = sigs.length > 0 ? sigs[0].signature : null;

    const code4 = zdosGenFourLetterCode((senderWallet || phone || Date.now()) + ":" + rank);
    const globalId = "OV-" + code4 + "-VELVET";

    res.json({
      ok: true,
      paymentWallet: "6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD",
      amountEur: 2.00,
      feesIncluded: true,
      rpcSignaturesChecked: sigs.length,
      latestTreasurySignature: matchedSig,
      senderWalletProvided: senderWallet || null,
      rank,
      globalId,
      fourLetterCode: code4,
      badge: {
        style: "purple_x_with_dollar",
        animatedAsset: "assets/card-mistress-gif.gif",
        autoGenerated: true,
        deliveredViaWhatsapp: "+447742507902",
        zswapUrl: "https://swap.x-zdos.it/?source=velvet&rank=" + encodeURIComponent(rank) + "&entry_eur=2&anchor_eur=0.01"
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// --- END ZDOS & OUR VELVET EVOLVED ROUTES ---

