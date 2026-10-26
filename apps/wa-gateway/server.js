const {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const express = require('express');
const app = express();

app.use(express.json());

let sock = null;
let connectionState = 'starting';
let latestQrDataUrl = null;
// groupFetchAllParticipating takes several seconds on an account with many groups, longer
// than the API waits, so the list is fetched in the background and served from here.
let groupCache = null;
let groupFetch = null;

function refreshGroups() {
  if (!sock || connectionState !== 'open') return Promise.resolve(groupCache);
  if (!groupFetch) {
    groupFetch = sock
      .groupFetchAllParticipating()
      .then((groupList) => {
        const groups = Object.entries(groupList || {}).map(([jid, meta]) => ({
          jid,
          subject: meta?.subject || jid,
        }));
        groups.sort((a, b) => (a.subject || '').localeCompare(b.subject || ''));
        groupCache = groups;
        return groups;
      })
      .finally(() => {
        groupFetch = null;
      });
  }
  return groupFetch;
}

function normalizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return '';
  const trimmed = chatId.trim();
  if (trimmed.endsWith('@c.us')) {
    return trimmed.replace('@c.us', '@s.whatsapp.net');
  }
  return trimmed;
}

// Logs never carry a full phone number: keep the first 5 and last 4 digits of each run.
function maskJid(jid) {
  return String(jid || '').replace(/\d{9,20}/g, (d) => `${d.slice(0, 5)}****${d.slice(-4)}`);
}

async function startWA() {
  console.log("Starting WhatsApp socket...");
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  // WhatsApp refuses the web-client version pinned in the package ("Connection Failure"
  // before any QR), so ask for the current one; keep the pinned one when offline.
  const version = await fetchLatestBaileysVersion()
    .then((latest) => latest.version)
    .catch(() => undefined);

  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);
  // A group joined or renamed shows up in the picker without waiting for the next refresh.
  sock.ev.on('groups.upsert', () => refreshGroups().catch(() => {}));
  sock.ev.on('groups.update', () => refreshGroups().catch(() => {}));

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionState = 'qr';
      console.log("\nScan QR Code berikut dengan WhatsApp HP kamu:\n");
      qrcode.generate(qr, { small: true });
      // Expose the QR as a PNG data URL so the dashboard can render it.
      QRCode.toDataURL(qr, { width: 320, margin: 1 })
        .then((url) => { latestQrDataUrl = url; })
        .catch((err) => console.error("QR encode failed:", err));
    }
    if (connection === 'close') {
      connectionState = 'closed';
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
      console.log('Connection closed. Reconnecting...', shouldReconnect);
      if (shouldReconnect) {
        // A short pause stops a refused connection from hammering WhatsApp in a tight loop.
        setTimeout(startWA, 3000);
      }
    } else if (connection === 'open') {
      connectionState = 'open';
      latestQrDataUrl = null;
      refreshGroups().catch((err) => console.error('Group list fetch failed:', err.message));
      console.log('\n======================================');
      console.log('WhatsApp connection opened successfully!');
      console.log('======================================\n');
    }
  });
}

app.get('/api/health', (req, res) => {
  res.json({
    provider: 'baileys',
    connected: Boolean(sock && connectionState === 'open'),
    state: connectionState,
    // The paired account ("62812...:7@s.whatsapp.net"). Loopback-only; the Pythia API
    // masks it before any client sees it, and it is never logged here.
    me: connectionState === 'open' ? sock?.user?.id || null : null,
    message: connectionState === 'open'
      ? 'WhatsApp gateway is connected.'
      : `WhatsApp gateway is ${connectionState}. Scan QR or wait for reconnect.`,
  });
});

app.get('/api/qr', (req, res) => {
  if (connectionState !== 'qr' || !latestQrDataUrl) {
    return res.json({ state: connectionState, qr: null });
  }
  res.json({ state: 'qr', qr: latestQrDataUrl });
});

app.get('/api/groups', async (req, res) => {
  if (!sock || connectionState !== 'open') {
    return res.json({ connected: false, groups: [], message: `Socket not ready (${connectionState}).` });
  }
  try {
    // A cached list answers at once and is refreshed behind it; the first call waits.
    const pending = refreshGroups();
    const groups = groupCache || (await pending);
    if (groupCache) pending.catch(() => {});
    res.json({ connected: true, groups, message: `${groups.length} groups found` });
  } catch (err) {
    res.status(500).json({ connected: true, groups: [], message: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  try {
    if (sock) {
      sock.end();
      sock = null;
    }
  } catch (err) {
    console.error("Logout cleanup error:", err);
  }
  try {
    fs.rmSync('baileys_auth_info', { recursive: true, force: true });
  } catch (err) {
    console.error("Auth folder cleanup error:", err);
  }
  connectionState = 'starting';
  latestQrDataUrl = null;
  startWA().catch((err) => console.error("Failed to restart socket:", err));
  res.json({ logged_out: true, state: connectionState });
});

app.post('/api/sessions/:sessionId/messages/send-text', async (req, res) => {
  const { chatId, text } = req.body;
  const targetChatId = normalizeChatId(chatId);
  console.log(`Received request to send to ${maskJid(targetChatId)}`);
  if (!targetChatId) {
    return res.status(400).json({ sent: false, provider: "baileys", error: "Missing chatId" });
  }
  if (!text) {
    return res.status(400).json({ sent: false, provider: "baileys", error: "Missing text" });
  }
  if (!sock || connectionState !== 'open') {
    return res.status(503).json({
      sent: false,
      provider: "baileys",
      error: `Socket not ready (${connectionState}). Scan QR or wait for reconnect.`
    });
  }
  try {
    await sock.sendMessage(targetChatId, { text: text });
    console.log(`Message successfully sent to ${maskJid(targetChatId)}`);
    res.json({ sent: true, provider: "baileys", message: "WhatsApp message sent.", chatId: targetChatId });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ sent: false, provider: "baileys", error: err.message });
  }
});

startWA().then(() => {
  // Every route here (send, /api/qr pairing QR, /api/groups, logout) is
  // unauthenticated: bind to loopback unless HOST says otherwise (the docker
  // service sets HOST=0.0.0.0 on its private network and publishes no host
  // port). Operators reach QR/groups only through the Pythia API, which gates
  // them to the administrator role. Never expose port 2785 publicly.
  const host = process.env.HOST || '127.0.0.1';
  app.listen(2785, host, () => {
    console.log(`WhatsApp Gateway (Baileys) listening on ${host}:2785`);
  });
}).catch(err => {
  console.error("Failed to start server:", err);
});
