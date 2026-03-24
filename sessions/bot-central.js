const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { obtenerContextoVendedor, guardarMensaje } = require('../services/supabase');
const { generarRespuesta } = require('../services/claude');

const SESSION_PATH = path.join(process.cwd(), 'sessions_data', 'bot-central');
const MAX_REINTENTOS = 3;
const logger = pino({ level: 'silent' });

// Estado del bot central
let botSocket = null;
let botEstado = null;
let botQR = null;
let reintentos = 0;

// Números de gerentes autorizados
function getGerentesAutorizados() {
  const nums = process.env.GERENTES_NUMEROS || '';
  return nums.split(',').map(n => n.trim()).filter(Boolean);
}

function getEstadoBotCentral() {
  return botEstado;
}

function getQRBotCentral() {
  return botQR;
}

async function iniciarBotCentral() {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
  botEstado = 'iniciando';
  global.logger.info('🤖 Iniciando Bot Central...');
  await conectarBotCentral();
}

async function conectarBotCentral() {
  const appLogger = global.logger;

  if (reintentos >= MAX_REINTENTOS) {
    appLogger.error(`⛔ Bot Central: máximo de reintentos (${MAX_REINTENTOS}) alcanzado. Detenido.`);
    botEstado = 'stopped';
    return;
  }

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Vector Bot', 'Chrome', '1.0.0'],
      getMessage: async () => undefined
    });

    botSocket = sock;
    botEstado = 'conectando';
    botQR = null;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        botQR = qr;
        botEstado = 'waiting_qr';
        appLogger.info('📱 QR del Bot Central listo - consulta /api/qr/bot-central');
      }

      if (connection === 'open') {
        botEstado = 'connected';
        botQR = null;
        reintentos = 0;
        appLogger.info('✅ Bot Central conectado y listo');
      }

      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const esLogout = codigo === DisconnectReason.loggedOut;

        botEstado = 'desconectado';
        botQR = null;
        botSocket = null;

        if (esLogout) {
          appLogger.warn('👋 Bot Central cerró sesión (logout). Eliminando credenciales.');
          fs.rmSync(SESSION_PATH, { recursive: true, force: true });
          fs.mkdirSync(SESSION_PATH, { recursive: true });
          reintentos = 0;
          botEstado = 'iniciando';
          setTimeout(conectarBotCentral, 3000);
          return;
        }

        reintentos++;
        const delay = Math.min(5000 * reintentos, 30000);
        appLogger.warn(`🔄 Bot Central desconectado (código ${codigo}). Reintento ${reintentos}/${MAX_REINTENTOS} en ${delay / 1000}s`);

        if (reintentos < MAX_REINTENTOS) {
          setTimeout(conectarBotCentral, delay);
        } else {
          appLogger.error('⛔ Bot Central: máximo reintentos alcanzado. El servidor HTTP sigue activo.');
          botEstado = 'stopped';
        }
      }
    });

    // Procesar mensajes entrantes (solo de gerentes autorizados)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;
        // Ignorar grupos
        if (msg.key.remoteJid.endsWith('@g.us')) continue;

        await procesarMensajeBotCentral(msg);
      }
    });

  } catch (err) {
    appLogger.error({ err }, 'Error al conectar Bot Central');
    botEstado = 'error';
    reintentos++;

    if (reintentos < MAX_REINTENTOS) {
      const delay = Math.min(5000 * reintentos, 30000);
      setTimeout(conectarBotCentral, delay);
    } else {
      botEstado = 'stopped';
    }
  }
}

async function procesarMensajeBotCentral(msg) {
  const appLogger = global.logger;

  try {
    const remitente = msg.key.remoteJid.replace('@s.whatsapp.net', '');
    const gerentesAutorizados = getGerentesAutorizados();

    // Solo procesar mensajes de gerentes autorizados
    if (!gerentesAutorizados.includes(remitente)) {
      appLogger.debug(`Bot Central: mensaje ignorado de número no autorizado ${remitente}`);
      return;
    }

    const texto = extraerTexto(msg.message);
    if (!texto) return;

    appLogger.info(`👔 Gerente ${remitente}: "${texto.substring(0, 50)}..."`);

    // El gerente puede enviar: "vendedor:XXXXX pregunta..."
    // o simplemente una pregunta general
    let vendedorId = null;
    let pregunta = texto;

    const match = texto.match(/^vendedor[:\s]+(\S+)\s+(.*)/is);
    if (match) {
      vendedorId = match[1];
      pregunta = match[2];
    }

    // Obtener contexto del vendedor desde Supabase
    let contexto = 'No hay contexto disponible aún.';
    if (vendedorId) {
      try {
        contexto = await obtenerContextoVendedor(vendedorId);
      } catch (err) {
        appLogger.warn({ err }, `No se pudo obtener contexto del vendedor ${vendedorId}`);
      }
    }

    // Generar respuesta con Claude
    const respuesta = await generarRespuesta({ pregunta, contexto, vendedorId });

    // Enviar respuesta al gerente
    await botSocket.sendMessage(msg.key.remoteJid, { text: respuesta });

    // Guardar vía proxy si hay vendedor identificado
    if (vendedorId) {
      await guardarMensaje(vendedorId, remitente, texto, true, null);
      await guardarMensaje(vendedorId, remitente, respuesta, false, null);
    }

    appLogger.info(`✉️ Respuesta enviada al gerente ${remitente}`);

  } catch (err) {
    appLogger.error({ err }, 'Error procesando mensaje Bot Central');
  }
}

async function enviarMensajeBotCentral(numero, mensaje) {
  if (!botSocket || botEstado !== 'connected') {
    throw new Error('Bot Central no está conectado');
  }

  const jid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
  await botSocket.sendMessage(jid, { text: mensaje });
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

async function reiniciarBotCentral() {
  const appLogger = global.logger;
  appLogger.info('♻️ Reiniciando Bot Central...');

  if (botSocket) {
    try { botSocket.end(new Error('reinicio manual')); } catch (_) {}
    botSocket = null;
  }
  reintentos = 0;
  botEstado = null;
  botQR = null;

  await iniciarBotCentral();
}

module.exports = {
  iniciarBotCentral,
  reiniciarBotCentral,
  enviarMensajeBotCentral,
  getEstadoBotCentral,
  getQRBotCentral
};
