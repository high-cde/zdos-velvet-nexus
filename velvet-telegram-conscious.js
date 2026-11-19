const crypto = require("crypto");

const SOL_TREASURY = "6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD";
const OV_MINT = "2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump";
const DSN_MINT = "35w74RT77BPSYNpmzpvxmR9wu2ihpgzubKy4bkGHR3F4";
const WA_CHANNEL = "https://whatsapp.com/channel/0029Vb9Rbee89inrYLhdem1n";
const WA_BRIDGE = "https://wa.me/447742507902";
const DISCORD_URL = "https://discord.gg/BcMh6vcpQX";

function ensureTgStore(db) {
  if (!db.users || typeof db.users !== "object") db.users = {};
  if (!db.handleLinks || typeof db.handleLinks !== "object") db.handleLinks = {};
  if (!db.tgSessions || typeof db.tgSessions !== "object") db.tgSessions = {};
}

function getOrCreateTgUser(db, msgOrUser) {
  ensureTgStore(db);
  const from = msgOrUser?.from || msgOrUser || {};
  const chatId = String(msgOrUser?.chat?.id || from.id || "").trim();
  const tgUsername = from.username ? "@" + String(from.username).replace(/^@+/, "") : null;
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || tgUsername || "Citizen 18+";

  let matchedKey = null;
  for (const [k, u] of Object.entries(db.users)) {
    if (!u || typeof u !== "object") continue;
    const ch = u.channels || {};
    if (
      (chatId && (ch.tgChatId === chatId || k === `tg:${chatId}`)) ||
      (tgUsername && ch.tgUser && String(ch.tgUser).toLowerCase() === tgUsername.toLowerCase())
    ) {
      matchedKey = k;
      break;
    }
  }

  if (!matchedKey) {
    matchedKey = chatId ? `tg:${chatId}` : `tg:${crypto.randomBytes(3).toString("hex")}`;
  }

  const existing = db.users[matchedKey] || {};
  const seed = `${chatId}|${tgUsername || ""}|VELVET_TG_CONSCIOUS`;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const digest = crypto.createHash("sha256").update(seed).digest();
  let code = "";
  for (let i = 0; i < 4; i++) code += alphabet[digest[i] % alphabet.length];

  const ovId = existing.ovId || `OV-${code}-VELVET`;
  const record = {
    ...existing,
    ovId,
    alias: existing.alias || fullName,
    status: existing.status || "REAL_VERIFIED",
    rank: existing.rank || "Citizen 18+",
    meatRole: existing.meatRole || "Ospite 18+",
    devotion: Number(existing.devotion || 10),
    consent18Plus: true,
    channels: {
      ...(existing.channels || {}),
      tgUser: tgUsername || existing.channels?.tgUser || null,
      tgChatId: chatId || existing.channels?.tgChatId || null,
      updatedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  };

  db.users[matchedKey] = record;
  db.handleLinks[ovId.toUpperCase()] = matchedKey;
  if (tgUsername) db.handleLinks[tgUsername.toLowerCase()] = matchedKey;
  if (chatId) db.handleLinks[chatId] = matchedKey;

  return { userKey: matchedKey, user: record, chatId };
}

function mainKeyboard(ovId) {
  const qOv = encodeURIComponent(ovId || "");
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "👤 Il Mio Stato", callback_data: "v_me" },
          { text: "🗝️ Forgia / ID $OV", callback_data: "v_forge" }
        ],
        [
          { text: "🩸 Radar 30km & IP", callback_data: "v_radar" },
          { text: "🌉 Bridge X·WA·TG", callback_data: "v_bridge" }
        ],
        [
          { text: "🖤 Shop & Stars (XTR)", callback_data: "v_shop" },
          { text: "🃏 Lodge Card", url: `https://velvet.x-zdos.it/lodge-card.html?ov=${qOv}` }
        ],
        [
          { text: "⚡ Command Deck", url: "https://velvet.x-zdos.it/dashboard.html" },
          { text: "🖤 Canale WA 18+", url: WA_CHANNEL }
        ]
      ]
    }
  };
}

function buildConsciousStatusText(user) {
  const ch = user.channels || {};
  const locStr = user.location
    ? `${user.location.lat}, ${user.location.lon} (30 km · ${user.location.city || "settore attivo"})`
    : "non ancora attivata (/radar o su web)";
  const walletStr = user.wallet
    ? `${user.wallet.slice(0, 6)}...${user.wallet.slice(-4)}`
    : "non collegato";

  return (
    `🖤 *VELVET CITY · IDENTITÀ CONSAPEVOLE (18+)*\n\n` +
    `• *Sigillo:* \`${user.ovId}\`\n` +
    `• *Alias / Ruolo:* _${user.alias || "Citizen"}_ · *${user.meatRole || user.rank || "Ospite 18+"}*\n` +
    `• *Devotion:* *${user.devotion || 0}* · *Stato:* \`${user.status}\`\n` +
    `• *Wallet Solana:* \`${walletStr}\`\n` +
    `• *Radar 30 km:* \`${locStr}\`\n` +
    `• *Canali:* X \`${ch.xHandle || "-"}\` · WA \`${ch.waPhone || "-"}\` · TG \`${ch.tgUser || "-"}\`\n\n` +
    `_Zero gioco · Consenso 18+ attivo · Build what you can prove._`
  );
}

async function sendStarsPackInvoice(tg, chatId, packKey = "PHOTO-VIDEO-PACK", starsAmount = 180) {
  const cleanStars = Math.max(1, Math.min(25000, Number(starsAmount || 180)));
  if (typeof tg.sendInvoice === "function") {
    try {
      await tg.sendInvoice(
        chatId,
        `Our Velvet · ${packKey}`,
        `Accesso riservato 18+ consensuale (${packKey}) su Velvet City & ZDOS.`,
        `velvet_stars:${packKey}:${Date.now()}`,
        "",
        "XTR",
        [{ label: "Velvet 18+ Stars", amount: cleanStars }]
      );
      return true;
    } catch (e) {}
  }
  await tg.sendMessage(
    chatId,
    `⭐ *PAGAMENTO TELEGRAM STARS (${cleanStars} XTR)*\n` +
      `Pacchetto: \`${packKey}\`\n` +
      `Apri lo Shop Multi-Pay (Stars / TON / Solana):\n` +
      `👉 https://velvet.x-zdos.it/shop.html?item=${encodeURIComponent(packKey)}`
  );
  return false;
}

function attachConsciousTelegram(tg, db, saveDB) {
  if (!tg || typeof tg.on !== "function") return false;
  ensureTgStore(db);

  // Evita doppia registrazione se già collegato
  if (tg.__velvetConsciousAttached) return true;
  tg.__velvetConsciousAttached = true;

  tg.on("message", async (msg) => {
    try {
      if (!msg || !msg.chat || !msg.text) return;
      const chatId = msg.chat.id;
      const rawText = String(msg.text).trim();
      const lower = rawText.toLowerCase();

      const { user } = getOrCreateTgUser(db, msg);
      saveDB();

      if (lower === "/start" || lower === "/menu" || lower === "/help") {
        const greeting =
          `⚡ *BENVENUTO IN VELVET CITY (${user.ovId})*\n` +
          `Ciao *${user.alias || "Citizen"}* — ti riconosco come \`${user.ovId}\` (*${user.meatRole || "Ospite 18+"}*).\n\n` +
          `Scegli un'azione rapida qui sotto oppure usa un comando diretto:\n` +
          `• \`/me\` — stato profilo, ruolo, wallet e radar\n` +
          `• \`/forge <walletSolana> [@handleX]\` — aggiorna identità reale\n` +
          `• \`/radar <lat> <lon> [ruolo]\` — imposta settore 30 km e scansiona\n` +
          `• \`/bridge @handleX [+telefonoWA]\` — collega i canali\n` +
          `• \`/stars [180]\` — fattura nativa Telegram Stars (XTR)\n` +
          `• \`/shop\` — Foto/Video 18+, Intimo, Slave Delivery & ZSwap`;

        return tg.sendMessage(chatId, greeting, mainKeyboard(user.ovId));
      }

      if (lower === "/me" || lower === "/status") {
        return tg.sendMessage(chatId, buildConsciousStatusText(user), mainKeyboard(user.ovId));
      }

      if (lower.startsWith("/forge")) {
        const parts = rawText.split(/\s+/).slice(1);
        for (const p of parts) {
          if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p)) {
            user.wallet = p;
            db.handleLinks[p] = `tg:${chatId}`;
          } else if (p.startsWith("@")) {
            user.channels = Object.assign({}, user.channels || {}, { xHandle: p });
            db.handleLinks[p.toLowerCase()] = `tg:${chatId}`;
          }
        }
        user.updatedAt = new Date().toISOString();
        saveDB();
        return tg.sendMessage(
          chatId,
          `🗝️ *SIGILLO AGGIORNATO:* \`${user.ovId}\`\n` +
            `Wallet: \`${user.wallet || "non impostato"}\` · X: \`${user.channels?.xHandle || "-"}\``,
          mainKeyboard(user.ovId)
        );
      }

      if (lower.startsWith("/radar")) {
        const parts = rawText.split(/\s+/).slice(1);
        const lat = Number(parts[0]);
        const lon = Number(parts[1]);
        if (!Number.isNaN(lat) && !Number.isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          user.location = {
            lat: Number(lat.toFixed(2)),
            lon: Number(lon.toFixed(2)),
            sessionMode: "TG-CONSCIOUS-30KM",
            radiusKm: 30,
            updatedAt: new Date().toISOString()
          };
          if (parts[2]) user.meatRole = parts.slice(2).join(" ").slice(0, 40);
          saveDB();
        }
        return tg.sendMessage(
          chatId,
          `🩸 *MEAT RADAR 30 KM (${user.ovId})*\n` +
            (user.location
              ? `Settore attivo: \`${user.location.lat}, ${user.location.lon}\` (raggio 30 km).\n`
              : `Nessuna coordinata salvata. Invia \`/radar 45.03 9.28\` o usa la dashboard web.\n`) +
            `👉 Scansiona e aggancia su web: https://velvet.x-zdos.it/user.html?ov=${encodeURIComponent(user.ovId)}`,
          mainKeyboard(user.ovId)
        );
      }

      if (lower.startsWith("/bridge")) {
        const parts = rawText.split(/\s+/).slice(1);
        user.channels = user.channels || {};
        for (const p of parts) {
          if (p.startsWith("@")) {
            if (!user.channels.xHandle) user.channels.xHandle = p;
            else user.channels.tgUser = p;
          } else if (/^\+?[0-9]{7,15}$/.test(p)) {
            user.channels.waPhone = p;
          }
        }
        user.bridgeToken =
          "BRG-" +
          crypto
            .createHash("sha256")
            .update(`${user.ovId}:${chatId}`)
            .digest("hex")
            .slice(0, 8)
            .toUpperCase();
        saveDB();
        return tg.sendMessage(
          chatId,
          `🌉 *OMNI BRIDGE SINCRONIZZATO (\`${user.ovId}\`)*\n` +
            `Token: \`${user.bridgeToken}\`\n` +
            `X: \`${user.channels.xHandle || "-"}\` · WA: \`${user.channels.waPhone || "-"}\` · TG: \`${user.channels.tgUser || "-"}\``,
          mainKeyboard(user.ovId)
        );
      }

      if (lower.startsWith("/stars")) {
        const amt = Number(rawText.split(/\s+/)[1] || 180);
        await sendStarsPackInvoice(tg, chatId, "PHOTO-VIDEO-PACK", amt);
        return;
      }

      if (lower === "/shop" || lower === "/pay") {
        return tg.sendMessage(
          chatId,
          `🖤 *OUR VELVET · SHOP & MULTI-PAY (18+)*\n` +
            `• *Telegram Stars (XTR)*, *TON Wallet* e *Solana* (\`SOL\`, \`$OV\`, \`$DSN\`)\n` +
            `• Tesoreria Solana: \`${SOL_TREASURY}\`\n` +
            `• Portale Shop & Slave Delivery: https://velvet.x-zdos.it/shop.html`,
          mainKeyboard(user.ovId)
        );
      }
    } catch (e) {
      // Silenzia errori non critici per mantenere fluidità
    }
  });

  tg.on("callback_query", async (cq) => {
    try {
      if (!cq || !cq.message) return;
      const chatId = cq.message.chat.id;
      const data = String(cq.data || "");
      const { user } = getOrCreateTgUser(db, { from: cq.from, chat: cq.message.chat });
      saveDB();

      if (typeof tg.answerCallbackQuery === "function") {
        await tg.answerCallbackQuery(cq.id).catch(() => {});
      }

      if (data === "v_me") {
        return tg.sendMessage(chatId, buildConsciousStatusText(user), mainKeyboard(user.ovId));
      }
      if (data === "v_forge") {
        return tg.sendMessage(
          chatId,
          `🗝️ *IL TUO SIGILLO GLOBALE:* \`${user.ovId}\`\n` +
            `Per collegare il wallet Solana o l'handle X scrivi:\n\`/forge <IndirizzoSolana> @tuoHandleX\``,
          mainKeyboard(user.ovId)
        );
      }
      if (data === "v_radar") {
        return tg.sendMessage(
          chatId,
          `🩸 *MEAT RADAR 30 KM*\n` +
            `Imposta le tue coordinate approssimate con \`/radar <lat> <lon>\` oppure apri il radar live:\n` +
            `👉 https://velvet.x-zdos.it/shop.html`,
          mainKeyboard(user.ovId)
        );
      }
      if (data === "v_bridge") {
        return tg.sendMessage(
          chatId,
          `🌉 *OMNI BRIDGE (X · WHATSAPP · TELEGRAM)*\n` +
            `Collega i tuoi handle con \`/bridge @handleX +447742507902\`.\n` +
            `• Ponte WhatsApp: ${WA_BRIDGE}\n• Discord Velvet City: ${DISCORD_URL}`,
          mainKeyboard(user.ovId)
        );
      }
      if (data === "v_shop") {
        await sendStarsPackInvoice(tg, chatId, "PHOTO-VIDEO-PACK", 180);
      }
    } catch (e) {}
  });

  if (typeof tg.on === "function") {
    tg.on("pre_checkout_query", async (q) => {
      if (typeof tg.answerPreCheckoutQuery === "function") {
        await tg.answerPreCheckoutQuery(q.id, true).catch(() => {});
      }
    });

    tg.on("successful_payment", async (msg) => {
      try {
        if (!msg || !msg.chat) return;
        const { user } = getOrCreateTgUser(db, msg);
        const sp = msg.successful_payment || {};
        const starsPaid = Number(sp.total_amount || 0);
        user.devotion = Number(user.devotion || 0) + Math.max(25, starsPaid);
        user.lastStarsPayment = {
          currency: sp.currency || "XTR",
          amount: starsPaid,
          payload: sp.invoice_payload || null,
          at: new Date().toISOString()
        };
        saveDB();
        await tg.sendMessage(
          msg.chat.id,
          `✅ *PAGAMENTO STARS VERIFICATO*\n` +
            `Sigillo: \`${user.ovId}\` · Ricevuti: *${starsPaid} ${sp.currency || "XTR"}*\n` +
            `Devotion aggiornata a *${user.devotion}*. Contenuto/accesso sbloccato.`,
          mainKeyboard(user.ovId)
        );
      } catch (e) {}
    });
  }

  return true;
}

module.exports = {
  SOL_TREASURY,
  OV_MINT,
  DSN_MINT,
  attachConsciousTelegram,
  buildConsciousStatusText
};
