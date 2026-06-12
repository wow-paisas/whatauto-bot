const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

const API_URL = process.env.API_URL || 'https://inmiti.site/autoresponder/api/index.php';
const API_TOKEN = process.env.API_TOKEN || '';
const PORT = process.env.PORT || 3000;

if (!API_TOKEN) { console.error('❌ Falta API_TOKEN'); process.exit(1); }

let qrDataUrl = null;
let conectado = false;
let intentos = 0;

const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (conectado) {
        res.end('<html><body style="background:#0a0f0a;color:#4ade80;font-family:sans-serif;text-align:center;padding:50px"><h1>✅ WhatsApp Conectado</h1><p>El bot está respondiendo mensajes automáticamente.</p></body></html>');
    } else if (qrDataUrl) {
        res.end(`<html><head><meta http-equiv="refresh" content="30"></head><body style="background:#0a0f0a;color:white;font-family:sans-serif;text-align:center;padding:30px">
<h2>📱 Escanea con WhatsApp</h2>
<p>WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo</p>
<img src="${qrDataUrl}" style="width:280px;height:280px;border:8px solid white;border-radius:12px;margin:20px"/>
<p style="color:#aaa;font-size:14px">La página se recarga automáticamente cada 30s</p>
</body></html>`);
    } else {
        res.end(`<html><head><meta http-equiv="refresh" content="5"></head><body style="background:#0a0f0a;color:white;font-family:sans-serif;text-align:center;padding:50px">
<h2>⏳ Conectando con WhatsApp...</h2><p>Intento ${intentos}. Recargando en 5 segundos...</p>
</body></html>`);
    }
});
server.listen(PORT, () => console.log(`🌐 Servidor QR en puerto ${PORT}`));

async function consultarAPI(app, remitente, mensaje) {
    try {
        const res = await axios.post(`${API_URL}?endpoint=match`,
            { app, remitente, mensaje },
            { headers: { 'X-Api-Token': API_TOKEN }, timeout: 8000 }
        );
        return res.data;
    } catch (e) {
        console.error('❌ Error API:', e.message);
        return null;
    }
}

const cooldown = new Map();

async function iniciarBot() {
    intentos++;
    console.log(`🔄 Intento de conexión #${intentos}`);
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    let version;
    try {
        const r = await fetchLatestBaileysVersion();
        version = r.version;
        console.log(`📦 Baileys versión: ${version}`);
    } catch(e) {
        version = [2, 3000, 1015901307];
        console.log('⚠️ Usando versión por defecto de Baileys');
    }

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['Ubuntu', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📱 QR generado — abre la URL para escanear');
            try { qrDataUrl = await qrcode.toDataURL(qr); } catch(e) {}
            conectado = false;
        }
        if (connection === 'open') {
            conectado = true;
            qrDataUrl = null;
            intentos = 0;
            console.log('✅ WhatsApp conectado y listo');
        }
        if (connection === 'close') {
            conectado = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`🔌 Desconectado. Código: ${statusCode}`);
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('⛔ Sesión cerrada por el usuario.');
                process.exit(0);
            }
            const delay = Math.min(5000 * intentos, 30000);
            console.log(`⏳ Reconectando en ${delay/1000}s...`);
            setTimeout(iniciarBot, delay);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid?.endsWith('@g.us')) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const remitente = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
            const texto = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption || '';
            if (!texto.trim()) continue;

            const ahora = Date.now();
            if (cooldown.has(remitente) && ahora - cooldown.get(remitente) < 5000) continue;
            cooldown.set(remitente, ahora);

            console.log(`📨 +${remitente}: "${texto.substring(0, 60)}"`);
            const resultado = await consultarAPI('whatsapp', remitente, texto);

            if (resultado?.ok && resultado.respuesta) {
                const delay = (resultado.delay || 0) * 1000;
                if (delay > 0) await new Promise(r => setTimeout(r, delay));
                await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                await new Promise(r => setTimeout(r, 1000));
                await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
                await sock.sendMessage(msg.key.remoteJid, { text: resultado.respuesta });
                console.log(`✉️ Respondido a +${remitente}`);
            }
        }
    });
}

iniciarBot().catch(err => {
    console.error('❌ Error fatal:', err.message);
    setTimeout(iniciarBot, 10000);
});
