const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { guardarMensaje, obtenerOCrearConversacion } = require('../services/supabase');
const { analizarMensaje } = require('../services/claude');

const SESSIONS_DIR = path.join(process.cwd(), 'sessions_data');
const MAX_REINTENTOS = 3;
const logger = pino({ level: 'silent' }); // Logger silencioso para Baileys

// Mapa de sesiones activas: vendedorId -> { socket, estado, qr, reintentos }
const sesiones = new Map();

function getSesionesActivas() {
  const supervisores = [];
  for (const [vendedorId, sesion] of sesiones.entries()) {
    supervisores.push({
      vendedorId,
      estado: sesion.estado,
      conectadoEn: sesion.conectadoEn || null
    });
  }
  return { supervisores };
}

function getEstadoSesion(vendedorId) {
  const sesion = sesiones.get(vendedorId);
  return sesion ? sesion.estado : null;
}

function getQRSesion(vendedorId) {
  const sesion = sesiones.get(vendedorId);
  return sesion ? sesion.qr : null;
}

async function iniciarSesionSupervisor(vendedorId) {
  const appLogger = global.logger;

  // Si ya existe y está conectada, no hacer nada
  const existente = sesiones.get(vendedorId);
  if (existente && existente.estado === 'conectado') {
    appLogger.info(`Sesión supervisor ${vendedorId} ya está conectada`);
    return;
  }

  const sessionPath = path.join(SESSIONS_DIR, `supervisor-${vendedorId}`);
  fs.mkdirSync(sessionPath, { recursive: true });

  // Inicializar entrada en el mapa
  sesiones.set(vendedorId, {
    estado: 'iniciando',
    qr: null,
    reintentos: existente ? existente.reintentos : 0,
    socket: null,
    conectadoEn: null
  });

  appLogger.info(`🟡 Iniciando sesión supervisor: ${vendedorId}`);

  await conectarSupervisor(vendedorId, sessionPath);
}

async function conectarSupervisor(vendedorId, sessionPath) {
  const appLogger = global.logger;
  const sesion = sesiones.get(vendedorId);

  if (!sesion) return;

  if (sesion.reintentos >= MAX_REINTENTOS) {
    appLogger.warn(`⛔ Sesión supervisor ${vendedorId}: máximo de reintentos alcanzado (${MAX_REINTENTOS}). Deteniendo.`);
    sesion.estado = 'detenido';
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
      browser: ['Vector Supervisor', 'Chrome', '1.0.0'],
      getMessage: async () => undefined
    });

    sesion.socket = sock;
    sesion.estado = 'conectando';
    sesion.qr = null;

    // Guardar credenciales
    sock.ev.on('creds.update', saveCreds);

    // Evento de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sesion.qr = qr;
        sesion.estado = 'esperando_qr';
        appLogger.info(`📱 QR listo para supervisor ${vendedorId} - consulta /api/qr/${vendedorId}`);
      }

      if (connection === 'open') {
        sesion.estado = 'conectado';
        sesion.qr = null;
        sesion.reintentos = 0;
        sesion.conectadoEn = new Date().toISOString();
        appLogger.info(`✅ Supervisor ${vendedorId} conectado`);
      }

      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const esLogout = codigo === DisconnectReason.loggedOut;

        sesion.estado = 'desconectado';
        sesion.qr = null;

        if (esLogout) {
          appLogger.warn(`👋 Supervisor ${vendedorId} cerró sesión (logout). Eliminando credenciales.`);
          fs.rmSync(sessionPath, { recursive: true, force: true });
          sesiones.delete(vendedorId);
          return;
        }

        sesion.reintentos++;
        const delay = Math.min(5000 * sesion.reintentos, 30000);
        appLogger.warn(`🔄 Supervisor ${vendedorId} desconectado (código ${codigo}). Reintento ${sesion.reintentos}/${MAX_REINTENTOS} en ${delay / 1000}s`);

        if (sesion.reintentos < MAX_REINTENTOS) {
          setTimeout(() => conectarSupervisor(vendedorId, sessionPath), delay);
        } else {
          appLogger.error(`⛔ Supervisor ${vendedorId}: máximo reintentos. Detenido.`);
          sesion.estado = 'detenido';
        }
      }
    });

    // Procesar mensajes entrantes (solo lectura)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Ignorar mensajes propios o sin contenido
        if (msg.key.fromMe || !msg.message) continue;

        await procesarMensajeSupervisor(vendedorId, msg);
      }
    });

  } catch (err) {
    appLogger.error({ err }, `Error al conectar supervisor ${vendedorId}`);
    if (sesion) {
      sesion.estado = 'error';
      sesion.reintentos++;
    }
  }
}

async function procesarMensajeSupervisor(vendedorId, msg) {
  const appLogger = global.logger;

  try {
    const remitente = msg.key.remoteJid;
    // Ignorar grupos
    if (remitente.endsWith('@g.us')) return;

    // Extraer texto del mensaje
    const texto = extraerTexto(msg.message);
    if (!texto) return;

    const prospectoNumero = remitente.replace('@s.whatsapp.net', '');
    appLogger.info(`📨 Supervisor ${vendedorId} | De: ${prospectoNumero} | "${texto.substring(0, 50)}..."`);

    // Obtener o crear conversación en Supabase
    const conversacionId = await obtenerOCrearConversacion(vendedorId, prospectoNumero);

    // Analizar con Claude
    let analisis = null;
    try {
      analisis = await analizarMensaje(texto);
    } catch (claudeErr) {
      appLogger.warn({ claudeErr }, 'Error al analizar con Claude, guardando sin análisis');
    }

    // Guardar en Supabase
    await guardarMensaje({
      conversacion_id: conversacionId,
      texto,
      direccion: 'entrante',
      analisis_claude: analisis
    });

    appLogger.info(`💾 Mensaje guardado | Vendedor: ${vendedorId} | Análisis: ${analisis ? 'OK' : 'sin análisis'}`);

  } catch (err) {
    appLogger.error({ err }, `Error procesando mensaje supervisor ${vendedorId}`);
  }
}

function extraerTexto(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    null
  );
}

async function cerrarSesionSupervisor(vendedorId) {
  const appLogger = global.logger;
  const sesion = sesiones.get(vendedorId);

  if (!sesion) {
    throw new Error(`Sesión ${vendedorId} no encontrada`);
  }

  try {
    if (sesion.socket) {
      await sesion.socket.logout();
    }
  } catch (err) {
    appLogger.warn({ err }, `Error al hacer logout de supervisor ${vendedorId}`);
  }

  sesiones.delete(vendedorId);
  appLogger.info(`🗑️ Sesión supervisor ${vendedorId} eliminada`);
}

module.exports = {
  iniciarSesionSupervisor,
  cerrarSesionSupervisor,
  getSesionesActivas,
  getEstadoSesion,
  getQRSesion
};
