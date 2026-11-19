#!/usr/bin/env bash
# zdiscord · inserisce token e Application ID senza mostrarli, registra i comandi slash, avvia il servizio
# e stampa il link di invito. Da lanciare come root: bash /opt/zdiscord/setup-token.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Lancia come root"; exit 1; }
read -r -s -p "DISCORD_TOKEN (non viene mostrato): " TOK; echo
read -r -s -p "APPLICATION_ID (non viene mostrato): " APP; echo
read -r -p "ID del server Discord per registrare subito i comandi (invio = comandi globali): " GID
[ -n "$TOK" ] && [ -n "$APP" ] || { echo "Token o Application ID vuoti: niente da fare"; exit 1; }
[[ "$TOK" =~ ^[A-Za-z0-9._-]{50,120}$ ]] || { echo "Il token non ha il formato atteso: copialo di nuovo da Bot > Reset Token"; exit 1; }
[[ "$APP" =~ ^[0-9]{15,22}$ ]] || { echo "APPLICATION_ID non valido (solo cifre)"; exit 1; }
[ -z "$GID" ] || [[ "$GID" =~ ^[0-9]{15,22}$ ]] || { echo "ID server non valido"; exit 1; }
install -d -m 750 -o root -g zdiscord /etc/zdiscord
umask 027
{ printf 'DISCORD_TOKEN=%s\n' "$TOK"; printf 'APPLICATION_ID=%s\n' "$APP"; [ -z "$GID" ] || printf 'DISCORD_GUILD_ID=%s\n' "$GID"; } > /etc/zdiscord/bot.env.tmp
chown root:zdiscord /etc/zdiscord/bot.env.tmp; chmod 640 /etc/zdiscord/bot.env.tmp; mv -f /etc/zdiscord/bot.env.tmp /etc/zdiscord/bot.env
unset TOK
echo "Token salvato in /etc/zdiscord/bot.env (640)."
cd /opt/zdiscord
if ! runuser -u zdiscord -- bash -c 'set -a; . /opt/zdiscord/config.env; . /etc/zdiscord/bot.env; set +a; exec /usr/bin/node src/register-commands.js'; then
  echo "Registrazione comandi fallita: controlla token e Application ID e rilancia questo script."; exit 1
fi
systemctl enable --now zdiscord
sleep 4
systemctl --no-pager --lines=5 status zdiscord || true
curl -fsS http://127.0.0.1:8790/discord/api/health && echo
echo
echo "Invita il bot nel server con questo link (permessi: Gestire canali e ruoli, Vedere canali, Inviare messaggi, Incorporare link, Allegare file, Leggere la cronologia, Usare i comandi):"
node /opt/zdiscord/src/invite.js "$APP"
echo
echo "Dopo l'invito, nel server usa /setup-server anteprima e poi /setup-server applica."
