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
const MAX_REINTENTOS = 10;
const logger = pino({ level: 'silent' });

function normalizarNumero(numero) {
  // Elimina todo excepto dígitos
  return numero.replace(/\D/g, '');
}

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
        const delay = 30000;
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
      console.log('📱 Bot Central | Mensaje recibido (raw):', JSON.stringify(messages, null, 2));

      if (type !== 'notify') return;

      for (const m of messages) {
        if (!m.message) continue;

        // Extraer el número real del remitente
        // participant existe cuando el mensaje viene de un chat individual
        // remoteJid es el respaldo
        // El número real está en senderPn (formato: 50672120211@s.whatsapp.net)
        const numeroRemite = m.key.senderPn || m.key.participant || m.key.remoteJid;
        console.log('📱 Mensaje | key completo:', JSON.stringify(m.key, null, 2));
        console.log('📱 Mensaje | remoteJid:', m.key.remoteJid);
        console.log('📱 Mensaje | participant:', m.key.participant);
        console.log('📱 Mensaje | senderPn:', m.key.senderPn);
        console.log('📱 Mensaje | fromMe:', m.key.fromMe);
        console.log('📱 Mensaje | Número extraído:', numeroRemite);

        // Ignorar mensajes propios
        if (m.key.fromMe) {
          console.log('⏭️ Mensaje propio, ignorando');
          continue;
        }

        // Ignorar grupos
        if (m.key.remoteJid.endsWith('@g.us')) continue;

        const numeroNormalizado = normalizarNumero(numeroRemite);
        console.log('📱 Bot Central | Número normalizado:', numeroNormalizado);

        const GERENTES_NUMEROS = getGerentesAutorizados();
        console.log('📱 Bot Central | Números autorizados:', GERENTES_NUMEROS);

        const esAutorizado = GERENTES_NUMEROS.some(n => {
          const nNormalizado = normalizarNumero(n);
          console.log('📱 Bot Central | Comparando:', numeroNormalizado, 'con', nNormalizado);
          return numeroNormalizado === nNormalizado ||
                 numeroNormalizado.includes(nNormalizado) ||
                 numeroNormalizado.endsWith(nNormalizado);
        });

        console.log('📱 Bot Central | ¿Es autorizado?:', esAutorizado);

        if (!esAutorizado) {
          console.log('❌ Bot Central | Mensaje de número no autorizado, ignorando');
          continue;
        }

        console.log('✅ Bot Central | Mensaje del gerente, procesando...');

        await procesarMensajeBotCentral(m);
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

    // Solo procesar mensajes de gerentes autorizados (con normalización de número)
    const remitenteNorm = normalizarNumero(remitente);
    const esGerente = gerentesAutorizados.some(n => {
      const nNorm = normalizarNumero(n);
      return remitenteNorm === nNorm || remitenteNorm.includes(nNorm) || remitenteNorm.endsWith(nNorm);
    });
    if (!esGerente) {
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

async function limpiarSesionBotCentral() {
  const appLogger = global.logger;
  appLogger.info('🧹 Limpiando sesión Bot Central...');

  if (botSocket) {
    try { botSocket.end(new Error('limpieza manual')); } catch (_) {}
    botSocket = null;
  }
  reintentos = 0;
  botEstado = 'stopped';
  botQR = null;

  fs.rmSync(SESSION_PATH, { recursive: true, force: true });
  appLogger.info(`🗑️ Carpeta de sesión eliminada: ${SESSION_PATH}`);
}

module.exports = {
  iniciarBotCentral,
  reiniciarBotCentral,
  limpiarSesionBotCentral,
  enviarMensajeBotCentral,
  getEstadoBotCentral,
  getQRBotCentral
};
