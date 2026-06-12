const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const pino = require('pino');

const API_URL = process.env.API_URL || 'https://inmiti.site/autoresponder/api/index.php';
const API_TOKEN = process.env.API_TOKEN || '';

if (!API_TOKEN) {
    console.error('❌ ERROR: Falta la variable de entorno API_TOKEN');
    console.error('   Configúrala en Railway con tu token_api del perfil');
    process.exit(1);
}

// Cooldown para evitar responder dos veces al mismo número en poco tiempo
const cooldown = new Map();
const COOLDOWN_MS = 5000; // 5 segundos

async function consultarAPI(app, remitente, mensaje) {
    try {
        const res = await axios.post(
            `${API_URL}?endpoint=match`,
            { app, remitente, mensaje },
            { headers: { 'X-Api-Token': API_TOKEN }, timeout: 8000 }
        );
        return res.data;
    } catch (e) {
        console.error('❌ Error consultando API:', e.message);
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

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n📱 ESCANEA ESTE QR CON WHATSAPP:');
            console.log('   WhatsApp → Dispositivos vinculados → Vincular dispositivo\n');
        }
        if (connection === 'open') {
            console.log('✅ WhatsApp conectado y listo para responder automáticamente');
        }
        if (connection === 'close') {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const reconectar = code !== DisconnectReason.loggedOut;
            console.log(`🔌 Desconectado (código ${code}). Reconectar: ${reconectar}`);
            if (reconectar) {
                setTimeout(iniciarBot, 3000);
            } else {
                console.log('⛔ Sesión cerrada. Borra la carpeta auth_info y reinicia.');
                process.exit(0);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignorar mensajes propios, de grupos y de estado
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid.endsWith('@g.us')) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const remitente = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const texto = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption
                || '';

            if (!texto.trim()) continue;

            // Cooldown por número
            const ahora = Date.now();
            if (cooldown.has(remitente) && ahora - cooldown.get(remitente) < COOLDOWN_MS) continue;
            cooldown.set(remitente, ahora);

            console.log(`📨 Mensaje de +${remitente}: "${texto.substring(0, 60)}"`);

            const resultado = await consultarAPI('whatsapp', remitente, texto);

            if (resultado?.ok && resultado.respuesta) {
                const delay = (resultado.delay || 0) * 1000;
                if (delay > 0) await new Promise(r => setTimeout(r, delay));

                // Simular que está escribiendo
                await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                await new Promise(r => setTimeout(r, 1200));
                await sock.sendPresenceUpdate('paused', msg.key.remoteJid);

                await sock.sendMessage(msg.key.remoteJid, { text: resultado.respuesta });
                console.log(`✉️  Respondido: "${resultado.respuesta.substring(0, 60)}"`);
            } else {
                console.log(`   Sin respuesta automática (sin_match)`);
            }
        }
    });
}

iniciarBot().catch(console.error);
