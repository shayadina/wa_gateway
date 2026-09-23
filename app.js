const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

let sock = null;
let currentQr = null;
let isConnected = false;
let connectedUser = null;
const authFolder = path.join(__dirname, 'auth_info_baileys');

const ERP_SYNC_URL = process.env.ERP_SYNC_URL || 'https://erp.sunonbd.com/supershops/wa_proxy.php';
const SECRET_KEY = 'SunonERP_WA_Secret_2026_SecureKey';

// Restore auth state from ERP MySQL Database on startup
async function restoreAuthFromCloud() {
    try {
        if (!fs.existsSync(authFolder)) {
            fs.mkdirSync(authFolder, { recursive: true });
        }
        
        // If local auth folder already has creds.json with valid keys, skip download
        if (fs.existsSync(path.join(authFolder, 'creds.json'))) {
            return;
        }

        console.log('Fetching session credentials from ERP database...');
        const res = await fetch(`${ERP_SYNC_URL}?action=load-auth&secret=${SECRET_KEY}`);
        const data = await res.json();
        
        if (data && data.authData) {
            const filesMap = JSON.parse(data.authData);
            for (const [filename, content] of Object.entries(filesMap)) {
                fs.writeFileSync(path.join(authFolder, filename), content, 'utf-8');
            }
            console.log('✅ Restored session files from cloud database!');
        }
    } catch (e) {
        console.error('Error restoring session from cloud database:', e.message);
    }
}

// Persist auth state back to ERP MySQL Database
async function syncAuthToCloud() {
    try {
        if (!fs.existsSync(authFolder)) return;
        const files = fs.readdirSync(authFolder);
        if (files.length === 0) return;

        const filesMap = {};
        for (const file of files) {
            const filePath = path.join(authFolder, file);
            if (fs.statSync(filePath).isFile()) {
                filesMap[file] = fs.readFileSync(filePath, 'utf-8');
            }
        }

        await fetch(`${ERP_SYNC_URL}?action=save-auth&secret=${SECRET_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(filesMap)
        });
        console.log('☁️ Session synced to ERP database.');
    } catch (e) {}
}

async function connectToWhatsApp() {
    try {
        await restoreAuthFromCloud();

        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            if (isConnected) {
                syncAuthToCloud();
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQr = qr;
                isConnected = false;
                connectedUser = null;
                console.log('New WhatsApp QR code generated.');
            }

            if (connection === 'open') {
                isConnected = true;
                currentQr = null;
                connectedUser = sock.user ? (sock.user.id || sock.user.name) : 'Connected User';
                console.log('✅ WhatsApp Gateway connected successfully as:', connectedUser);
                syncAuthToCloud();
            }

            if (connection === 'close') {
                isConnected = false;
                connectedUser = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`Connection closed (reason code: ${statusCode}). Should reconnect: ${shouldReconnect}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('User unlinked account from phone. Cleaning auth credentials...');
                    try {
                        fs.rmSync(authFolder, { recursive: true, force: true });
                        fetch(`${ERP_SYNC_URL}?action=clear-auth&secret=${SECRET_KEY}`).catch(() => {});
                    } catch (e) {}
                    currentQr = null;
                    sock = null;
                } else if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                    console.log('WhatsApp requested restart. Reconnecting immediately...');
                    connectToWhatsApp();
                } else if (shouldReconnect) {
                    console.log('Auto-reconnecting in 5 seconds...');
                    setTimeout(connectToWhatsApp, 5000);
                }
            }
        });
    } catch (err) {
        console.error('Error in WhatsApp connection setup:', err);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// Keep-Alive Self-Ping every 3 minutes to keep Render web instance alive
setInterval(() => {
    try {
        const targetPingUrl = process.env.RENDER_EXTERNAL_URL || 'https://wa-gateway-o7xr.onrender.com';
        fetch(`${targetPingUrl}/status`).catch(() => {});
    } catch(e) {}
}, 3 * 60 * 1000);

// Helper to resolve route action name
function getAction(req) {
    const q = req.query.route || req.query.action || req.query.endpoint;
    if (q) return q.toLowerCase();
    const p = (req.path || '').toLowerCase().replace(/\/+$/, '');
    if (p.endsWith('status')) return 'status';
    if (p.endsWith('qr')) return 'qr';
    if (p.endsWith('groups')) return 'groups';
    if (p.endsWith('send-group-message')) return 'send-group-message';
    if (p.endsWith('pair-code')) return 'pair-code';
    if (p.endsWith('logout')) return 'logout';
    return 'status';
}

// ── GET /status ──────────────────────────────────────────────────────────────
app.all(['/status', '/'], (req, res) => {
    const action = getAction(req);
    if (action === 'send-group-message') return handleSendMessage(req, res);
    if (action === 'pair-code') return handlePairCode(req, res);
    if (action === 'groups') return handleGroups(req, res);
    if (action === 'qr') return handleQr(req, res);

    return res.json({
        success: true,
        connected: isConnected,
        user: connectedUser,
        hasQr: !!currentQr
    });
});

// ── GET /qr ──────────────────────────────────────────────────────────────────
app.get('/qr', handleQr);
async function handleQr(req, res) {
    try {
        if (isConnected) {
            return res.json({ success: true, connected: true, message: 'Already connected to WhatsApp.' });
        }
        if (!currentQr) {
            return res.json({ success: false, connected: false, message: 'QR Code is generating, please refresh in 3 seconds...' });
        }
        const qrDataUrl = await QRCode.toDataURL(currentQr);
        return res.json({ success: true, connected: false, qrUrl: qrDataUrl, rawQr: currentQr });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
}

// ── GET /groups ──────────────────────────────────────────────────────────────
app.get('/groups', handleGroups);
async function handleGroups(req, res) {
    if (!isConnected || !sock) {
        return res.status(400).json({ success: false, message: 'WhatsApp Gateway is not connected.' });
    }
    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats).map(g => ({
            id: g.id,
            subject: g.subject || 'WhatsApp Group',
            participantsCount: g.participants ? g.participants.length : 0
        }));
        return res.json({ success: true, count: groups.length, groups });
    } catch (err) {
        console.error('Error fetching groups:', err);
        return res.status(500).json({ success: false, error: err.message || 'Could not fetch groups' });
    }
}

// ── POST /send-group-message ──────────────────────────────────────────────────
app.all('/send-group-message', handleSendMessage);
async function handleSendMessage(req, res) {
    if (!isConnected || !sock) {
        return res.status(400).json({ success: false, message: 'WhatsApp Gateway is not connected to any device.' });
    }

    const body = req.body || {};
    let { groupId, text, to } = body;
    let targetJid = groupId || to || req.query.groupId || req.query.to;

    if (!targetJid) {
        return res.status(400).json({ success: false, message: 'Target WhatsApp Group ID or Phone Number is required.' });
    }

    // Auto format Bangladesh phone numbers starting with 01 to 8801...
    if (!targetJid.includes('@')) {
        let clean = String(targetJid).replace(/[^0-9]/g, '');
        if (clean.startsWith('01')) {
            clean = '880' + clean.substring(1);
        } else if (clean.startsWith('1') && clean.length === 10) {
            clean = '880' + clean;
        }
        
        if (clean.length > 15) {
            targetJid = `${clean}@g.us`;
        } else {
            targetJid = `${clean}@s.whatsapp.net`;
        }
    }

    if (!text) {
        text = req.query.text || 'Test message';
    }

    try {
        // Pre-fetch group metadata if target is a group JID (@g.us) to hydrate participant encryption keys
        if (targetJid.endsWith('@g.us')) {
            try {
                await Promise.race([
                    sock.groupMetadata(targetJid),
                    new Promise(r => setTimeout(r, 4000))
                ]);
            } catch(e) {}
        }

        // Send message with 25s Promise timeout
        const sendPromise = sock.sendMessage(targetJid, { text });
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('WhatsApp socket timed out sending message. Ensure recipient is valid.')), 25000)
        );

        const sentMsg = await Promise.race([sendPromise, timeoutPromise]);
        return res.json({
            success: true,
            message: 'Message dispatched to WhatsApp successfully.',
            msgId: sentMsg.key ? sentMsg.key.id : 'OK'
        });
    } catch (err) {
        console.error('Error sending WhatsApp message:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to send message.' });
    }
}

// ── POST /pair-code ──────────────────────────────────────────────────────────
app.all('/pair-code', handlePairCode);
async function handlePairCode(req, res) {
    const body = req.body || {};
    const bodyPhone = body.phoneNumber || body.phone || req.query.phoneNumber || req.query.phone;
    if (!bodyPhone) {
        return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }
    if (isConnected) {
        return res.json({ success: true, connected: true, message: 'WhatsApp is already connected.' });
    }
    try {
        // Clean any stale un-paired auth files before creating new pairing request
        if (fs.existsSync(authFolder) && !fs.existsSync(path.join(authFolder, 'creds.json'))) {
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch(e){}
        }

        if (!sock) {
            await connectToWhatsApp();
            await new Promise(r => setTimeout(r, 2500));
        }

        let cleanPhone = String(bodyPhone).replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('01')) {
            cleanPhone = '880' + cleanPhone.substring(1);
        }
        if (cleanPhone.length < 8) {
            return res.status(400).json({ success: false, message: 'Invalid phone number format.' });
        }
        const code = await sock.requestPairingCode(cleanPhone);
        const formattedCode = code ? code.match(/.{1,4}/g)?.join('-') : code;
        return res.json({
            success: true,
            pairingCode: formattedCode || code,
            message: 'Pairing code generated!'
        });
    } catch (err) {
        console.error('Error requesting pairing code:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to generate pairing code.' });
    }
}

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Sunon WhatsApp Gateway REST API running on port ${PORT}`);
    connectToWhatsApp();
});
