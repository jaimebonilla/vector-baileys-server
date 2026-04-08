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
const { analizarMensaje } = require('../services/claude');

const SESSIONS_DIR = path.join(process.cwd(), 'sessions_data');
const MAX_REINTENTOS = 10;
const EDGE_FUNCTION_BASE = 'https://vqlesrbrrxscydvjjeux.supabase.co/functions/v1/railway-proxy';
const logger = pino({ level: 'silent' }); // Logger silencioso para Baileys

async function guardarInteraccion(vendedorId, numeroProspecto, texto, esEntrante, lidId) {
  try {
    // Paso 1: Buscar o crear cliente
    const responseCliente = await fetch(`${EDGE_FUNCTION_BASE}/buscar-o-crear-cliente`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telefono: numeroProspecto,
        email: null,
        nombre: null,
        vendedor_id: vendedorId
      })
    });

    const { cliente } = await responseCliente.json();

    if (!cliente) {
      console.error('❌ No se pudo crear/encontrar cliente');
      return;
    }

    // Paso 2: Guardar interacción
    const responseInteraccion = await fetch(`${EDGE_FUNCTION_BASE}/guardar-interaccion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: cliente.id,
        vendedor_id: vendedorId,
        tipo: 'mensaje',
        canal: 'whatsapp',
        direccion: esEntrante ? 'entrante' : 'saliente',
        contenido: texto,
        timestamp: new Date().toISOString(),
        metadata: { lid_id: lidId }
      })
    });

    const result = await responseInteraccion.json();

    if (result.success) {
      console.log(`✅ Interacción guardada | Cliente: ${cliente.telefono || cliente.id}`);
    }
  } catch (error) {
    console.error('❌ Error guardando interacción:', error);
  }
}

// Mapa de sesiones activas: vendedorId -> { socket, estado, qr, reintentos, conversacionesMap }
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
  if (existente && existente.estado === 'connected') {
    appLogger.info(`Sesión supervisor ${vendedorId} ya está conectada`);
    return;
  }

  const sessionPath = path.join(SESSIONS_DIR, `supervisor-${vendedorId}`);
  fs.mkdirSync(sessionPath, { recursive: true });

  // Inicializar entrada en el mapa — conservar conversacionesMap si ya existía
  sesiones.set(vendedorId, {
    estado: 'iniciando',
    qr: null,
    reintentos: existente ? existente.reintentos : 0,
    socket: null,
    conectadoEn: null,
    conversacionesMap: existente?.conversacionesMap || new Map() // persistir entre reconexiones
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
    sesion.estado = 'stopped';
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

    // Map local por vendedor: "@lid" → número real del prospecto
    const conversacionesMap = sesion.conversacionesMap;

    // Guardar credenciales
    sock.ev.on('creds.update', saveCreds);

    // Evento de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sesion.qr = qr;
        sesion.estado = 'waiting_qr';
        appLogger.info(`📱 QR listo para supervisor ${vendedorId} - consulta /api/qr/${vendedorId}`);
      }

      if (connection === 'open') {
        sesion.estado = 'connected';
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
        const delay = 30000;
        appLogger.warn(`🔄 Supervisor ${vendedorId} desconectado (código ${codigo}). Reintento ${sesion.reintentos}/${MAX_REINTENTOS} en ${delay / 1000}s`);

        if (sesion.reintentos < MAX_REINTENTOS) {
          setTimeout(() => conectarSupervisor(vendedorId, sessionPath), delay);
        } else {
          appLogger.error(`⛔ Supervisor ${vendedorId}: máximo reintentos. Detenido.`);
          sesion.estado = 'stopped';
        }
      }
    });

    // Procesar mensajes (entrantes y salientes)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid;

        // A) Filtrar estados de WhatsApp y broadcasts (no son conversaciones reales)
        if (remoteJid.includes('broadcast') || remoteJid === 'status@broadcast') {
          console.log(`⏭️ ${vendedorId} | Ignorando estado/broadcast: ${remoteJid}`);
          continue;
        }

        // Ignorar grupos
        if (remoteJid.endsWith('@g.us')) continue;

        // Extraer texto
        const texto = extraerTexto(msg.message);
        if (!texto) continue;

        const esDelVendedor = msg.key.fromMe === true;
        const direccion = esDelVendedor ? 'saliente' : 'entrante';
        let numeroProspecto;

        if (!esDelVendedor) {
          // ── MENSAJE ENTRANTE ──────────────────────────────────────────
          // senderPn tiene el número real del cliente
          numeroProspecto = msg.key.senderPn || remoteJid;

          // Guardar mapeo @lid → número real para futuros mensajes salientes
          // Solo si el número resuelto es un número real (@s.whatsapp.net), no un @lid
          if (remoteJid.includes('@lid') && numeroProspecto.includes('@s.whatsapp.net')) {
            // C) No sobrescribir si ya existe un mapeo válido para esta conversación
            if (!conversacionesMap.has(remoteJid)) {
              conversacionesMap.set(remoteJid, numeroProspecto);
              console.log(`📋 ${vendedorId} | Nuevo mapeo: ${remoteJid} → ${numeroProspecto}`);
            } else {
              console.log(`📋 ${vendedorId} | Mapeo ya existe: ${remoteJid} → ${conversacionesMap.get(remoteJid)}`);
            }
          }

        } else {
          // ── MENSAJE SALIENTE ──────────────────────────────────────────
          console.log(`📤 ${vendedorId} | Mensaje SALIENTE detectado`);
          console.log(`📤 ${vendedorId} | remoteJid: ${remoteJid}`);

          if (remoteJid.includes('@s.whatsapp.net')) {
            // remoteJid ya contiene el número real
            numeroProspecto = remoteJid;
            console.log(`📱 ${vendedorId} | Saliente directo: ${remoteJid}`);

          } else if (remoteJid.includes('@lid')) {
            // B) Logs detallados para debug del mapeo @lid
            console.log(`🔍 ${vendedorId} | Buscando en Map para @lid: ${remoteJid}`);
            numeroProspecto = conversacionesMap.get(remoteJid);
            console.log(`✅ ${vendedorId} | Resultado del Map: ${numeroProspecto || 'NO ENCONTRADO'}`);

            if (!numeroProspecto) {
              // Fallback: consultar Supabase
              console.log(`🔍 ${vendedorId} | Buscando en BD para: ${remoteJid}`);
              try {
                const response = await fetch(`${EDGE_FUNCTION_BASE}/buscar-prospecto-por-lid`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ vendedor_id: vendedorId, lid_id: remoteJid })
                });
                const { prospecto_numero } = await response.json();
                if (prospecto_numero) {
                  numeroProspecto = prospecto_numero;
                  conversacionesMap.set(remoteJid, numeroProspecto); // cachear
                  console.log(`✅ ${vendedorId} | Encontrado en BD: ${remoteJid} → ${numeroProspecto}`);
                }
              } catch (err) {
                console.error(`❌ ${vendedorId} | Error buscando en BD:`, err.message);
              }
            }

            // Sin número disponible → omitir
            if (!numeroProspecto) {
              console.log(`⚠️ ${vendedorId} | No se pudo determinar prospecto para ${remoteJid}, ignorando`);
              continue;
            }

          } else {
            // Otro formato desconocido
            numeroProspecto = remoteJid;
            console.log(`📱 ${vendedorId} | Saliente fallback: ${remoteJid}`);
          }
        }

        // Limpiar formato del número
        const numeroLimpio = numeroProspecto
          .replace('@s.whatsapp.net', '')
          .replace('@lid', '')
          .replace('@c.us', '');

        console.log(`📱 Supervisor ${vendedorId} | ${direccion} | Prospecto: ${numeroLimpio}`);
        appLogger.info(`📨 Supervisor ${vendedorId} | ${direccion} | Prospecto: ${numeroLimpio} | "${texto.substring(0, 50)}..."`);

        const lidId = remoteJid.includes('@lid') ? remoteJid : null;

        try {
          await guardarInteraccion(vendedorId, numeroLimpio, texto, !esDelVendedor, lidId);
          appLogger.info(`💾 Guardado | Vendedor: ${vendedorId} | Dirección: ${direccion}`);
        } catch (err) {
          appLogger.error({ err }, `Error guardando interacción supervisor ${vendedorId}`);
        }
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

async function reiniciarSesionSupervisor(vendedorId) {
  const appLogger = global.logger;
  appLogger.info(`♻️ Reiniciando sesión supervisor: ${vendedorId}`);

  const sesion = sesiones.get(vendedorId);
  if (sesion?.socket) {
    try { sesion.socket.end(new Error('reinicio manual')); } catch (_) {}
  }
  sesiones.delete(vendedorId);

  await iniciarSesionSupervisor(vendedorId);
}

async function limpiarSesionSupervisor(vendedorId) {
  const appLogger = global.logger;
  appLogger.info(`🧹 Limpiando sesión supervisor: ${vendedorId}`);

  const sesion = sesiones.get(vendedorId);
  if (sesion?.socket) {
    try { sesion.socket.end(new Error('limpieza manual')); } catch (_) {}
  }
  sesiones.delete(vendedorId);

  const sessionPath = path.join(SESSIONS_DIR, vendedorId);
  fs.rmSync(sessionPath, { recursive: true, force: true });
  appLogger.info(`🗑️ Carpeta de sesión eliminada: ${sessionPath}`);
}

module.exports = {
  iniciarSesionSupervisor,
  reiniciarSesionSupervisor,
  cerrarSesionSupervisor,
  limpiarSesionSupervisor,
  getSesionesActivas,
  getEstadoSesion,
  getQRSesion
};
