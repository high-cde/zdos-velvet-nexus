'use strict';
// Messaggi guida fissati da /setup-server (uno per canale, del bot, aggiornati se cambiano: mai duplicati).
// Tono sobrio: nessun rendimento promesso, nessun link pump.fun, $OV si chiama VELVET, nessuna affiliazione Musk/SpaceX.
// © 2026 ZDOS1.3 — P.IVA 11040550961 · Licenza ZSEL proprietaria.
const crypto = require('crypto');
const C = require('./constants');

const LINKS = {
  token: 'https://x-zdos.it/#token', // la pagina /dsn oggi risponde 404: si usa la sezione token della home
  zroute: 'https://swap.x-zdos.it/zroute/',
  quest: 'https://quest.x-zdos.it',
  ide: 'https://x-zdos.it/ide/',
  xcloud: 'https://x-zdos.it/xcloud/',
  telegram: 'https://t.me/OurVelvetHub',
  home: 'https://x-zdos.it/',
};
// Airdrop VELVET: dati comunicati da ZDOS1.3. Il ruolo Discord che conta come "verificato" non è ancora deciso:
// finché AIRDROP_VERIFIED_ROLE (solo testo, in config.env) è vuoto si mostra il segnaposto. Il bot non crea né assegna ruoli airdrop.
const AIRDROP = {
  from: '15/12/2026', to: '24/03/2027', maxWallets: 100, amount: '20.000',
  rolePlaceholder: '⏳ DA COMUNICARE: lo staff indicherà qui quale ruolo Discord conta come verificato',
};
const FOOT = { text: 'Server $DSN · ZDOS1.3 · nessun rendimento promesso, non è consulenza finanziaria' };
const linkList = () => [
  '• Token $DSN e VELVET: ' + LINKS.token,
  '• zRoute (swap con controlli K.I.R.A.): ' + LINKS.zroute,
  '• ZQuest: ' + LINKS.quest,
  '• Zlang IDE: ' + LINKS.ide,
  '• Telegram OurVelvetHub: ' + LINKS.telegram,
].join('\n');

const RULES = [
  'Rispetto per tutti: niente insulti, discriminazioni o molestie.',
  'Niente spam, flood, menzioni di massa, pubblicità o inviti ad altri server.',
  'Link ammessi: x-zdos.it, t.me/OurVelvetHub, discord, solscan, polygonscan, jup.ag. Gli altri link vengono bloccati in automatico.',
  'Niente shilling di altri token e niente promesse di guadagno. $DSN e VELVET sono token di comunità: nessuno qui promette rendimenti.',
  'Lo staff non ti chiederà mai seed phrase, chiavi private, pagamenti o di "sincronizzare" il wallet. Non firmare transazioni da link ricevuti in privato.',
  'ZDOS1.3 non è affiliata a Elon Musk, SpaceX, X Corp o ad altre aziende: diffida di chi lo dice.',
  'Contenuti per adulti solo nella 18+ ROOM, dopo la verifica in #ingresso-18. Nel resto del server niente NSFW.',
  'Privacy: niente dati personali tuoi o di altri (indirizzi, telefoni, documenti, foto private).',
  'Gli account Discord creati da poco restano in #verifica-accesso finché lo staff non li approva.',
  'La moderazione è automatica (AutoMod di Discord + bot) e manuale. Chi viola le regole perde i ruoli o viene allontanato.',
];

function build(opts = {}) {
  const days = opts.minAccountDays || 7;
  return [
    { channel: 'benvenuto', kind: 'g:benvenuto', title: 'Benvenuto nel server $DSN', payload: { embeds: [{
      title: '👋 Benvenuto nel server $DSN · ZDOS1.3', color: C.COLORS.violet,
      description: 'Il server della community dell\'ecosistema ZDOS (z-xSOLANA): $DSN, VELVET, zRoute, Zlang IDE, ZQuest e xCLOUD. Gestito da ZDOS1.3.\n\n'
        + '**Da dove partire**\n1. Leggi #regole.\n2. Segui #annunci per le novità ufficiali.\n3. In #info trovi cosa sono $DSN e VELVET.\n'
        + '4. Hai $DSN o VELVET? Usa /verifica per il ruolo Holder: firmi un messaggio di testo, nessuna transazione.\n'
        + '5. Sei maggiorenne e vuoi la 18+ ROOM? Vai in #ingresso-18.\n'
        + '6. Airdrop VELVET: regole solo in #airdrop-velvet.\n\n'
        + '**Comandi**: /stato · /token · /kira <mint> · /quest · /velvet\n\n**Link ufficiali**\n' + linkList(),
      footer: { text: 'Nessuno dello staff ti scrive in privato per primo · ZDOS1.3' },
    }] } },
    { channel: 'regole', kind: 'g:regole', title: 'Regole del server', payload: { embeds: [{
      title: '📜 Regole del server $DSN', color: C.COLORS.cyan,
      description: RULES.map((r, i) => (i + 1) + '. ' + r).join('\n') + '\n\nPer la 18+ ROOM valgono anche le regole in #ingresso-18 e #regole-18.',
      footer: FOOT,
    }] } },
    { channel: 'annunci', kind: 'g:annunci', title: 'Come funziona #annunci', payload: { embeds: [{
      title: '📢 Annunci ufficiali', color: C.COLORS.violet,
      description: 'Qui scrive solo lo staff di ZDOS1.3: aggiornamenti dei servizi, eventi, manutenzioni.\n\n'
        + '• Gli annunci non chiedono mai di collegare il wallet fuori dai domini x-zdos.it.\n'
        + '• Nessun rendimento e nessuna "prevendita". L\'unico airdrop ufficiale (VELVET) è descritto in #airdrop-velvet: diffida di ogni altro.\n'
        + '• Se qualcuno ti scrive in privato dicendo di essere dello staff, è una truffa: segnalalo.',
      footer: FOOT,
    }] } },
    { channel: 'info', kind: 'g:info', title: '$DSN, VELVET e servizi', payload: { embeds: [{
      title: 'ℹ️ $DSN, VELVET e i servizi ZDOS', color: C.COLORS.violet,
      fields: [
        { name: '$DSN · Solana (ufficiale)', value: '`' + C.DSN_SOL + '`\nToken-2022 · 6 decimali · mint e freeze authority revocate.\n**Oggi non esiste un pool di liquidità su Solana**: $DSN non è scambiabile e Jupiter non lo quota. Diffida di chi lo vende.\n[Solscan](https://solscan.io/token/' + C.DSN_SOL + ')' },
        { name: '$DSN · Polygon', value: '`' + C.DSN_POLYGON + '`\n[Polygonscan](https://polygonscan.com/token/' + C.DSN_POLYGON + ')' },
        { name: 'VELVET ($OV) · Solana', value: '`' + C.VELVET + '`\nToken di comunità di VelvetHub. Prezzo e liquidità attuali con /token.\n[Solscan](https://solscan.io/token/' + C.VELVET + ')' },
        { name: 'Servizi', value: '• zRoute: ' + LINKS.zroute + '\n• Zlang IDE: ' + LINKS.ide + '\n• ZQuest: ' + LINKS.quest + '\n• xCLOUD by ZDOS (gestionale, versione demo con dati di prova): ' + LINKS.xcloud },
        { name: 'Pagina ufficiale', value: LINKS.token },
      ],
      description: 'Nessun rendimento promesso. L\'airdrop VELVET ha regole proprie in #airdrop-velvet. Prima di comprare qualsiasi token usa /kira <mint>.',
      footer: FOOT,
    }] } },
    { channel: 'zroute', kind: 'g:zroute', title: 'Guida zRoute', payload: { embeds: [{
      title: '🔀 zRoute · guida breve', url: LINKS.zroute, color: C.COLORS.green,
      description: 'Swap su Solana tramite Jupiter, con i controlli K.I.R.A. (e RugCheck) mostrati prima della firma e l\'opzione bundle Jito.\n\n'
        + '1. Apri ' + LINKS.zroute + ' e collega Phantom.\n2. Scegli i token e leggi l\'esito K.I.R.A.\n3. Firmi solo tu, in Phantom: zRoute non custodisce fondi.\n\n'
        + 'Nessuna commissione aggiuntiva di ZDOS; restano le fee di rete Solana e l\'eventuale tip Jito se lo scegli. $DSN oggi non ha pool su Solana: zRoute non può scambiarlo.',
      footer: FOOT,
    }] } },
    { channel: 'ide', kind: 'g:ide', title: 'Guida Zlang IDE', payload: { embeds: [{
      title: '🧩 Zlang IDE · guida breve', url: LINKS.ide, color: C.COLORS.cyan,
      description: 'Editor nel browser in stile Remix per il linguaggio Zlang: compilazione reale (zlangc in JS, compilatore e VM Rust in WASM), esecuzione nella VM e ancoraggio facoltativo su devnet con Phantom.\n\n'
        + 'Zlang è un linguaggio minimale: oggi non genera programmi Solana. ' + LINKS.ide,
      footer: FOOT,
    }] } },
    { channel: 'zquest', kind: 'g:zquest', title: 'Guida ZQuest', payload: { embeds: [{
      title: '🎯 ZQuest · guida breve', url: LINKS.quest, color: C.COLORS.green,
      description: 'Missioni e progressi dell\'ecosistema ZDOS: ' + LINKS.quest + ' (anche con /quest).\nNessun premio in token promesso.',
      footer: FOOT,
    }] } },
    { channel: 'holder-lounge', kind: 'g:holder', title: 'Holder lounge', payload: { embeds: [{
      title: '💎 Holder lounge', color: C.COLORS.violet,
      description: 'Canale per chi ha il ruolo Holder $DSN o Holder VELVET.\n\n• Il ruolo si ottiene con /verifica: firmi un messaggio di testo, nessuna transazione, nessun accesso ai fondi.\n• Se alla verifica il saldo è zero, il ruolo viene tolto.\n• Essere holder non dà diritto a rendimenti o premi.',
      footer: FOOT,
    }] } },
    { channel: 'verifica-accesso', kind: 'g:verifica', title: 'Sei in verifica', payload: { embeds: [{
      title: '🚧 Sei in verifica', color: C.COLORS.warn,
      description: 'Il tuo account Discord è molto recente (meno di ' + days + ' giorni) oppure sei entrato durante un picco anomalo di ingressi.\n\n'
        + '• Finché lo staff non ti approva vedi solo questo canale.\n• Gli account nuovi si sbloccano anche da soli quando superano i ' + days + ' giorni.\n'
        + '• Nessuno dello staff ti chiederà wallet, seed phrase o pagamenti per sbloccarti.\n\nIntanto puoi leggere le regole qui sotto.',
      fields: [{ name: 'Regole in breve', value: RULES.slice(0, 6).map((r) => '• ' + r).join('\n').slice(0, 1024) }],
      footer: FOOT,
    }] } },
    ...airdrop(opts),
  ];
}

function airdrop(opts = {}) {
  const role = String(opts.airdropRole || '').trim();
  const AD = AIRDROP;
  return [
    { channel: 'airdrop-velvet', kind: 'g:airdrop', title: 'Airdrop VELVET · regole', payload: { embeds: [{
      title: '🎁 Airdrop VELVET ($OV) · regole', color: C.COLORS.violet,
      description: 'Airdrop di comunità di VELVET organizzato da ZDOS1.3.\n\n'
        + '**Periodo**: dal ' + AD.from + ' al ' + AD.to + '.\n'
        + '**Posti**: massimo ' + AD.maxWallets + ' wallet.\n'
        + '**Quantità**: ' + AD.amount + ' VELVET ($OV) per ogni wallet ammesso.\n\n'
        + '**Requisiti (tutti e tre)**\n'
        + '1. Rispondere al post ufficiale dell\'airdrop su X: il link sarà pubblicato qui e in #annunci.\n'
        + '2. Completare la quest su ' + LINKS.quest + '.\n'
        + '3. Avere su Discord il ruolo verificato: ' + (role ? '**' + role + '**' : '**' + AD.rolePlaceholder + '**') + '.\n\n'
        + 'Le modalità per indicare il wallet e i criteri se le richieste superano i posti saranno pubblicati solo qui.',
      fields: [
        { name: 'Da sapere', value: '• Nessuna promessa di guadagno o di valore: VELVET è un token di comunità e il suo prezzo può anche essere zero. DYOR.\n'
          + '• Non è consulenza finanziaria. Partecipare non dà diritto ad altri premi.' },
        { name: '🛡️ Anti-truffa', value: '• Lo staff non scrive mai in DM per primo: chi lo fa è un truffatore, segnalalo in #airdrop-domande.\n'
          + '• Nessuno ti chiederà seed phrase, chiavi private, pagamenti o "fee" anticipate.\n'
          + '• Non firmare transazioni per "ricevere" l\'airdrop da link ricevuti in privato.\n'
          + '• Link validi solo sui domini x-zdos.it.' },
      ],
      footer: { text: 'Airdrop VELVET · ZDOS1.3 · DYOR · nessun guadagno promesso' },
    }] } },
    { channel: 'airdrop-domande', kind: 'g:airdrop-domande', title: 'Domande airdrop', payload: { embeds: [{
      title: '❓ Domande sull\'airdrop VELVET', color: C.COLORS.cyan,
      description: 'Qui puoi chiedere chiarimenti sull\'airdrop. Le regole ufficiali sono solo in #airdrop-velvet.\n\n'
        + '• Non pubblicare seed phrase, chiavi private o dati personali.\n'
        + '• Lo staff risponde qui, in pubblico: non scrive mai in DM per primo.\n'
        + '• Ignora chi ti offre "posti garantiti" o ti chiede di pagare.\n'
        + '• Link validi solo sui domini x-zdos.it. DYOR.',
      footer: FOOT,
    }] } },
  ];
}

// Impronta del contenuto: serve a capire se il messaggio fisso va aggiornato.
function hashPayload(payload) {
  const norm = JSON.stringify(payload, (k, v) => (v && typeof v.toJSON === 'function' && !(v instanceof Date) ? v.toJSON() : v));
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

module.exports = { build, airdrop, hashPayload, LINKS, RULES, AIRDROP };
