const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

const API_URL = process.env.API_URL || 'https://inmiti.site/autoresponder/api/index.php';
const API_TOKEN = process.env.API_TOKEN || '';
const PORT = process.env.PORT || 3000;

if (!API_TOKEN) {
    console.error('❌ ERROR: Falta la variable de entorno API_TOKEN');
    process.exit(1);
}

let qrDataUrl = null;
let conectado = false;

// Servidor HTTP para mostrar el QR
const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (conectado) {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#0a0f0a;color:#4ade80"><h1>✅ WhatsApp Conectado</h1><p>El bot está funcionando correctamente.</p></body></html>');
    } else if (qrDataUrl) {
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#0a0f0a;color:white">
<h1>📱 Escanea este QR con WhatsApp</h1>
<p>WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
<img src="${qrDataUrl}" style="width:300px;height:300px;border:10px solid white;border-radius:10px"/>
<p style="color:#aaa">El QR expira en ~60 segundos. Si expira, recarga la página.</p>
</body></html>`);
    } else {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#0a0f0a;color:white"><h1>⏳ Iniciando bot...</h1><p>Recarga en unos segundos.</p></body></html>');
    }
});
server.listen(PORT, () => console.log(`🌐 Servidor QR en puerto ${PORT}`));

const cooldown = new Map();
const COOLDOWN_MS = 5000;

async function consultarAPI(app, remitente, mensaje) {
    try {
        const res = await axios.post(
            `${API_URL}?endpoint=match`,
            { app, remitente, mensaje },
            { headers: { 'X-Api-Token': API_TOKEN }, timeout: 8000 }
        );
        return res.data;
    } catch (e) {
        console.error('❌ Error API:', e.message);
        return null;
    }
}

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['INMITI WhataAuto', 'Chrome', '1.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('📱 QR generado — abre la URL del servicio en Railway para escanearlo');
            qrDataUrl = await qrcode.toDataURL(qr);
            conectado = false;
        }
        if (connection === 'open') {
            conectado = true;
            qrDataUrl = null;
            console.log('✅ WhatsApp conectado');
        }
        if (connection === 'close') {
            conectado = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const reconectar = code !== DisconnectReason.loggedOut;
            console.log(`🔌 Desconectado (${code}). Reconectar: ${reconectar}`);
            if (reconectar) setTimeout(iniciarBot, 5000);
            else { console.log('⛔ Sesión cerrada.'); process.exit(0); }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid.endsWith('@g.us')) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const remitente = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (!texto.trim()) continue;

            const ahora = Date.now();
            if (cooldown.has(remitente) && ahora - cooldown.get(remitente) < COOLDOWN_MS) continue;
            cooldown.set(remitente, ahora);

            console.log(`📨 +${remitente}: "${texto.substring(0, 60)}"`);
            const resultado = await consultarAPI('whatsapp', remitente, texto);

            if (resultado?.ok && resultado.respuesta) {
                const delay = (resultado.delay || 0) * 1000;
                if (delay > 0) await new Promise(r => setTimeout(r, delay));
                await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                await new Promise(r => setTimeout(r, 1200));
                await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
                await sock.sendMessage(msg.key.remoteJid, { text: resultado.respuesta });
                console.log(`✉️ Respondido: "${resultado.respuesta.substring(0, 60)}"`);
            }
        }
    });
}

iniciarBot().catch(console.error);
