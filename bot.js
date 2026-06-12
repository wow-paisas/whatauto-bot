/**
 * Whatauto Bot - Multi-sesión
 * Cada usuario tiene su propia sesión de WhatsApp
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios  = require('axios');
const pino   = require('pino');
const http   = require('http');
const qrcode = require('qrcode');
const fs     = require('fs');
const path   = require('path');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const API_URL   = process.env.API_URL   || 'https://inmiti.site/autoresponder/api/index.php';
const BOT_TOKEN = process.env.BOT_TOKEN || '';   // Token secreto entre Railway y PHP
const PORT      = process.env.PORT      || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!BOT_TOKEN) { console.error('❌ Falta BOT_TOKEN'); process.exit(1); }
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── ESTADO GLOBAL ──────────────────────────────────────────────────────────
// sesiones[uid] = { sock, estado, qrDataUrl, intentos, cooldown }
const sesiones = {};

// ── HELPERS ────────────────────────────────────────────────────────────────
function authDir(uid) {
    return path.join(SESSIONS_DIR, `user_${uid}`);
}

async function consultarAPI(uid, app, remitente, mensaje) {
    try {
        const res = await axios.post(`${API_URL}?endpoint=match`,
            { app, remitente, mensaje, uid },
            { headers: { 'X-Bot-Token': BOT_TOKEN }, timeout: 8000 }
        );
        return res.data;
    } catch (e) {
        console.error(`❌ [uid:${uid}] Error API:`, e.message);
        return null;
    }
}

// ── INICIAR SESIÓN DE UN USUARIO ────────────────────────────────────────────
async function iniciarSesion(uid) {
    // Si ya hay una sesión activa para este uid, no la duplicamos
    if (sesiones[uid]?.estado === 'conectado') {
        console.log(`ℹ️ [uid:${uid}] Ya está conectado`);
        return;
    }

    // Si hay socket anterior, lo cerramos limpiamente
    if (sesiones[uid]?.sock) {
        try { sesiones[uid].sock.end(); } catch(_) {}
    }

    sesiones[uid] = sesiones[uid] || {};
    sesiones[uid].estado    = 'conectando';
    sesiones[uid].qrDataUrl = null;
    sesiones[uid].intentos  = (sesiones[uid].intentos || 0) + 1;
    sesiones[uid].cooldown  = sesiones[uid].cooldown || new Map();

    console.log(`🔄 [uid:${uid}] Intento #${sesiones[uid].intentos}`);

    const dir = authDir(uid);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dir);

    let version;
    try {
        const r = await fetchLatestBaileysVersion();
        version = r.version;
    } catch(_) {
        version = [2, 3000, 1035194821];
    }

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
    });

    sesiones[uid].sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log(`📱 [uid:${uid}] QR generado`);
            try {
                sesiones[uid].qrDataUrl = await qrcode.toDataURL(qr);
                sesiones[uid].estado    = 'esperando_qr';
            } catch(_) {}
        }

        if (connection === 'open') {
            sesiones[uid].estado    = 'conectado';
            sesiones[uid].qrDataUrl = null;
            sesiones[uid].intentos  = 0;
            console.log(`✅ [uid:${uid}] Conectado`);

            // Notificar al panel PHP que el usuario se conectó
            try {
                await axios.post(`${API_URL}?endpoint=notify_connected`,
                    { uid },
                    { headers: { 'X-Bot-Token': BOT_TOKEN }, timeout: 5000 }
                );
            } catch(_) {}
        }

        if (connection === 'close') {
            sesiones[uid].estado = 'desconectado';
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`🔌 [uid:${uid}] Desconectado. Código: ${code}`);

            if (code === DisconnectReason.loggedOut) {
                console.log(`⛔ [uid:${uid}] Sesión cerrada — eliminando auth`);
                eliminarAuthDir(uid);
                delete sesiones[uid];

                // Notificar desconexión al panel
                try {
                    await axios.post(`${API_URL}?endpoint=notify_disconnected`,
                        { uid },
                        { headers: { 'X-Bot-Token': BOT_TOKEN }, timeout: 5000 }
                    );
                } catch(_) {}
                return;
            }

            // Reconectar con backoff
            const delay = Math.min(5000 * (sesiones[uid]?.intentos || 1), 30000);
            console.log(`⏳ [uid:${uid}] Reconectando en ${delay/1000}s...`);
            setTimeout(() => iniciarSesion(uid), delay);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid?.endsWith('@g.us')) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const remitente = msg.key.remoteJid || '';
            const texto = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption || '';
            if (!texto.trim()) continue;

            const ahora = Date.now();
            const cd = sesiones[uid]?.cooldown;
            if (cd?.has(remitente) && ahora - cd.get(remitente) < 5000) continue;
            cd?.set(remitente, ahora);

            console.log(`📨 [uid:${uid}] +${remitente}: "${texto.substring(0,60)}"`);
            const resultado = await consultarAPI(uid, 'whatsapp', remitente, texto);

            if (resultado?.ok && resultado.respuesta) {
                const delay = (resultado.delay || 0) * 1000;
                if (delay > 0) await new Promise(r => setTimeout(r, delay));
                await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                await new Promise(r => setTimeout(r, 1000));
                await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
                await sock.sendMessage(msg.key.remoteJid, { text: resultado.respuesta });
                console.log(`✉️ [uid:${uid}] Respondido a ${remitente}`);
            }
        }
    });
}

function eliminarAuthDir(uid) {
    const dir = authDir(uid);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`🗑️ [uid:${uid}] Auth eliminado`);
    }
}

async function desconectarSesion(uid) {
    if (sesiones[uid]?.sock) {
        try { await sesiones[uid].sock.logout(); } catch(_) {}
        try { sesiones[uid].sock.end(); } catch(_) {}
    }
    eliminarAuthDir(uid);
    delete sesiones[uid];
}

// ── RESTAURAR SESIONES EXISTENTES AL ARRANCAR ───────────────────────────────
async function restaurarSesiones() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const dirs = fs.readdirSync(SESSIONS_DIR);
    for (const d of dirs) {
        const m = d.match(/^user_(\d+)$/);
        if (!m) continue;
        const uid = m[1];
        const credsPath = path.join(SESSIONS_DIR, d, 'creds.json');
        if (fs.existsSync(credsPath)) {
            console.log(`♻️ Restaurando sesión uid:${uid}`);
            iniciarSesion(uid).catch(e => console.error(`❌ Error restaurando uid:${uid}`, e.message));
        }
    }
}

// ── SERVIDOR HTTP ──────────────────────────────────────────────────────────
// Endpoints que llama el panel PHP:
//   POST /session/start     { uid }          → inicia sesión
//   GET  /session/qr/:uid                    → devuelve el QR como imagen HTML
//   GET  /session/status/:uid                → devuelve JSON con estado
//   POST /session/disconnect { uid }         → desconecta y elimina sesión
//   GET  /sessions                           → lista todas las sesiones activas

const server = http.createServer(async (req, res) => {
    // Verificar token en todas las peticiones
    const token = req.headers['x-bot-token'] || new URL(req.url, 'http://x').searchParams.get('token');
    if (token !== BOT_TOKEN) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Leer body POST
    let body = {};
    if (req.method === 'POST') {
        const raw = await new Promise(resolve => {
            let d = '';
            req.on('data', c => d += c);
            req.on('end', () => resolve(d));
        });
        try { body = JSON.parse(raw); } catch(_) {}
    }

    res.setHeader('Content-Type', 'application/json');

    // POST /session/start
    if (req.method === 'POST' && pathname === '/session/start') {
        const uid = String(body.uid || '');
        if (!uid) { res.writeHead(400); res.end(JSON.stringify({ error: 'uid requerido' })); return; }
        iniciarSesion(uid).catch(e => console.error(e));
        res.end(JSON.stringify({ ok: true, mensaje: 'Sesión iniciando' }));
        return;
    }

    // GET /session/qr/:uid
    if (req.method === 'GET' && pathname.startsWith('/session/qr/')) {
        const uid = pathname.split('/')[3];
        const s = sesiones[uid];
        if (!s) { res.writeHead(404); res.end(JSON.stringify({ error: 'Sesión no encontrada' })); return; }
        if (s.estado === 'conectado') {
            res.end(JSON.stringify({ ok: true, estado: 'conectado', qr: null }));
        } else if (s.qrDataUrl) {
            res.end(JSON.stringify({ ok: true, estado: s.estado, qr: s.qrDataUrl }));
        } else {
            res.end(JSON.stringify({ ok: true, estado: s.estado, qr: null }));
        }
        return;
    }

    // GET /session/status/:uid
    if (req.method === 'GET' && pathname.startsWith('/session/status/')) {
        const uid = pathname.split('/')[3];
        const s = sesiones[uid];
        res.end(JSON.stringify({
            ok: true,
            uid,
            estado: s?.estado || 'sin_sesion',
            tiene_qr: !!s?.qrDataUrl,
        }));
        return;
    }

    // POST /session/disconnect
    if (req.method === 'POST' && pathname === '/session/disconnect') {
        const uid = String(body.uid || '');
        if (!uid) { res.writeHead(400); res.end(JSON.stringify({ error: 'uid requerido' })); return; }
        await desconectarSesion(uid);
        res.end(JSON.stringify({ ok: true, mensaje: 'Sesión desconectada' }));
        return;
    }

    // GET /sessions
    if (req.method === 'GET' && pathname === '/sessions') {
        const lista = Object.entries(sesiones).map(([uid, s]) => ({
            uid,
            estado: s.estado,
            tiene_qr: !!s.qrDataUrl,
        }));
        res.end(JSON.stringify({ ok: true, sesiones: lista }));
        return;
    }

    // GET / — health check
    if (req.method === 'GET' && pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        const total = Object.keys(sesiones).length;
        const conectados = Object.values(sesiones).filter(s => s.estado === 'conectado').length;
        res.end(`<html><body style="background:#0a0f0a;color:#4ade80;font-family:sans-serif;text-align:center;padding:50px">
            <h1>🤖 Whatauto Bot</h1>
            <p>Sesiones totales: ${total} | Conectadas: ${conectados}</p>
        </body></html>`);
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, async () => {
    console.log(`🌐 Bot multi-sesión escuchando en puerto ${PORT}`);
    await restaurarSesiones();
});
