const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const SESSIONS_DIR = path.join(process.cwd(), 'sessions_data');
const MAX_REINTENTOS = 10;
const logger = pino({ level: 'silent' });

function normalizarNumero(numero) {
  return numero.replace(/\D/g, '');
}

// Map de bots centrales: slug -> { socket, estado, qr, reintentos }
const botCentrales = new Map();

function getGerentesAutorizados() {
  const nums = process.env.GERENTES_NUMEROS || '';
  return nums.split(',').map(n => n.trim()).filter(Boolean);
}

/**
 * Retorna el estado de un bot-central por slug.
 * Sin slug: compatibilidad con alertas.js — retorna 'connected' si alguno está conectado.
 */
function getEstadoBotCentral(slug) {
  if (!slug) {
    for (const bot of botCentrales.values()) {
      if (bot.estado === 'connected') return 'connected';
    }
    const first = botCentrales.values().next().value;
    return first ? first.estado : null;
  }
  return botCentrales.get(slug)?.estado || null;
}

function getQRBotCentral(slug) {
  return botCentrales.get(slug)?.qr || null;
}

/**
 * Lista todos los bot-centrales activos para el endpoint GET /api/sesiones.
 */
function getAllBotCentrales() {
  const result = [];
  for (const [slug, bot] of botCentrales.entries()) {
    result.push({
      slug,
      sessionId: `bot-central-${slug}`,
      estado: bot.estado,
      qrUrl: `/api/qr/bot-central-${slug}`
    });
  }
  return result;
}

/**
 * Inicia (o reinicia) el bot-central para un slug dado.
 * @param {string} slug - Identificador de la empresa (ej: "alianza_capitales")
 */
async function iniciarBotCentral(slug) {
  const appLogger = global.logger;
  const sessionPath = path.join(SESSIONS_DIR, `bot-central-${slug}`);
  fs.mkdirSync(sessionPath, { recursive: true });

  const existente = botCentrales.get(slug);
  if (existente?.estado === 'connected') {
    appLogger.info(`Bot Central ${slug} ya está conectado`);
    return;
  }

  botCentrales.set(slug, {
    estado: 'iniciando',
    socket: null,
    qr: null,
    reintentos: existente?.reintentos || 0
  });

  appLogger.info(`🤖 Iniciando Bot Central: ${slug}`);
  await conectarBotCentral(slug, sessionPath);
}

async function conectarBotCentral(slug, sessionPath) {
  const appLogger = global.logger;
  const bot = botCentrales.get(slug);
  if (!bot) return;

  if (bot.reintentos >= MAX_REINTENTOS) {
    appLogger.error(`⛔ Bot Central ${slug}: máximo de reintentos (${MAX_REINTENTOS}) alcanzado. Detenido.`);
    bot.estado = 'stopped';
    return;
  }

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: [`Vector Bot ${slug}`, 'Chrome', '1.0.0'],
      getMessage: async () => undefined
    });

    bot.socket = sock;
    bot.estado = 'conectando';
    bot.qr = null;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        bot.qr = qr;
        bot.estado = 'waiting_qr';
        appLogger.info(`📱 QR Bot Central ${slug} listo → /api/qr/bot-central-${slug}`);
      }

      if (connection === 'open') {
        bot.estado = 'connected';
        bot.qr = null;
        bot.reintentos = 0;
        appLogger.info(`✅ Bot Central ${slug} conectado y listo`);
      }

      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const esLogout = codigo === DisconnectReason.loggedOut;

        bot.estado = 'desconectado';
        bot.qr = null;
        bot.socket = null;

        if (esLogout) {
          appLogger.warn(`👋 Bot Central ${slug} hizo logout. Eliminando credenciales.`);
          fs.rmSync(sessionPath, { recursive: true, force: true });
          fs.mkdirSync(sessionPath, { recursive: true });
          bot.reintentos = 0;
          bot.estado = 'iniciando';
          setTimeout(() => conectarBotCentral(slug, sessionPath), 3000);
          return;
        }

        bot.reintentos++;
        const delay = 30000;
        appLogger.warn(`🔄 Bot Central ${slug} desconectado (código ${codigo}). Reintento ${bot.reintentos}/${MAX_REINTENTOS} en ${delay / 1000}s`);

        if (bot.reintentos < MAX_REINTENTOS) {
          setTimeout(() => conectarBotCentral(slug, sessionPath), delay);
        } else {
          appLogger.error(`⛔ Bot Central ${slug}: máximo reintentos. Detenido.`);
          bot.estado = 'stopped';
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        await procesarMensajeBotCentral(slug, m, sock);
      }
    });

  } catch (err) {
    appLogger.error({ err }, `Error al conectar Bot Central ${slug}`);
    if (bot) {
      bot.estado = 'error';
      bot.reintentos++;
      const delay = Math.min(5000 * bot.reintentos, 30000);
      if (bot.reintentos < MAX_REINTENTOS) {
        setTimeout(() => conectarBotCentral(slug, sessionPath), delay);
      } else {
        bot.estado = 'stopped';
      }
    }
  }
}

async function procesarMensajeBotCentral(slug, msg, sock) {
  const appLogger = global.logger;

  try {
    if (!msg.message) return;
    if (msg.key.fromMe) return;
    if (msg.key.remoteJid.endsWith('@g.us')) return;

    const remitenteRaw = msg.key.senderPn || msg.key.participant || msg.key.remoteJid;
    const remitente = remitenteRaw.replace('@s.whatsapp.net', '').replace('@c.us', '');

    const gerentesAutorizados = getGerentesAutorizados();
    const remitenteNorm = normalizarNumero(remitente);
    const esGerente = gerentesAutorizados.some(n => {
      const nNorm = normalizarNumero(n);
      return remitenteNorm === nNorm || remitenteNorm.includes(nNorm) || remitenteNorm.endsWith(nNorm);
    });

    if (!esGerente) {
      appLogger.debug(`Bot Central ${slug}: mensaje ignorado de número no autorizado ${remitente}`);
      return;
    }

    const texto = extraerTexto(msg.message);
    if (!texto) return;

    appLogger.info(`👔 Gerente ${remitente} → ${slug}: "${texto.substring(0, 50)}..."`);

    const edgeUrl = process.env.LOVABLE_EDGE_URL;
    if (!edgeUrl) {
      appLogger.error('LOVABLE_EDGE_URL no configurada');
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'Error de configuración del servidor. Contacta al administrador.'
      }, { ephemeralExpiration: 0 });
      return;
    }

    const response = await fetch(`${edgeUrl}/agente-central-responder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero_gerente: remitente, mensaje: texto, slug })
    });

    if (!response.ok) {
      throw new Error(`Edge function respondió con ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const respuesta = data.respuesta || data.text || data.message;

    if (!respuesta) {
      throw new Error('Edge function no devolvió campo respuesta/text/message');
    }

    await sock.sendMessage(msg.key.remoteJid, { text: respuesta }, { ephemeralExpiration: 0 });
    appLogger.info(`✉️ Respuesta enviada al gerente ${remitente} (${slug})`);

  } catch (err) {
    appLogger.error({ err }, `Error procesando mensaje Bot Central ${slug}`);
    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'Disculpa, hubo un error procesando tu solicitud.'
      }, { ephemeralExpiration: 0 });
    } catch (_) {}
  }
}

function extraerTexto(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

/**
 * Envía un mensaje desde el bot-central de un slug.
 * Firma: (numero, mensaje, slug?) — mantiene compatibilidad con alertas.js
 * que llama enviarMensajeBotCentral(gerente, alerta.mensaje) sin slug.
 */
async function enviarMensajeBotCentral(numero, mensaje, slug) {
  let bot;

  if (slug) {
    bot = botCentrales.get(slug);
  } else {
    // Compatibilidad: usar el primer bot conectado disponible
    for (const b of botCentrales.values()) {
      if (b.estado === 'connected') { bot = b; break; }
    }
  }

  if (!bot || bot.estado !== 'connected') {
    throw new Error(`Bot Central${slug ? ` ${slug}` : ''} no está conectado`);
  }

  const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
  await bot.socket.sendMessage(jid, { text: mensaje }, { ephemeralExpiration: 0 });
}

/**
 * Envía un mensaje saliente desde el bot-central de un slug.
 * Requiere slug explícito, devuelve el messageId de Baileys.
 * Lanza errores con .code para control de flujo en el endpoint HTTP.
 */
async function enviarMensajeDesdeBot(slug, numero, mensaje) {
  const bot = botCentrales.get(slug);

  if (!bot) {
    const err = new Error('session_not_found');
    err.code = 'session_not_found';
    throw err;
  }

  if (bot.estado !== 'connected') {
    const err = new Error('not_connected');
    err.code = 'not_connected';
    throw err;
  }

  const jid = `${numero}@s.whatsapp.net`;
  const sent = await bot.socket.sendMessage(jid, { text: mensaje }, { ephemeralExpiration: 0 });
  return sent?.key?.id;
}

async function reiniciarBotCentral(slug) {
  const appLogger = global.logger;
  appLogger.info(`♻️ Reiniciando Bot Central: ${slug}`);

  const bot = botCentrales.get(slug);
  if (bot?.socket) {
    try { bot.socket.end(new Error('reinicio manual')); } catch (_) {}
  }
  botCentrales.delete(slug);

  await iniciarBotCentral(slug);
}

async function limpiarSesionBotCentral(slug) {
  const appLogger = global.logger;
  appLogger.info(`🧹 Limpiando sesión Bot Central: ${slug}`);

  const bot = botCentrales.get(slug);
  if (bot?.socket) {
    try { bot.socket.end(new Error('limpieza manual')); } catch (_) {}
  }
  botCentrales.delete(slug);

  const sessionPath = path.join(SESSIONS_DIR, `bot-central-${slug}`);
  fs.rmSync(sessionPath, { recursive: true, force: true });
  appLogger.info(`🗑️ Carpeta de sesión eliminada: ${sessionPath}`);
}

module.exports = {
  iniciarBotCentral,
  reiniciarBotCentral,
  limpiarSesionBotCentral,
  enviarMensajeBotCentral,
  enviarMensajeDesdeBot,
  getEstadoBotCentral,
  getQRBotCentral,
  getAllBotCentrales
};
