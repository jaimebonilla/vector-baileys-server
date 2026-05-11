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
const logger = pino({ level: 'silent' });

function lidMapPath(sessionPath) {
  return path.join(sessionPath, 'lid-map.json');
}

function loadLidMap(sessionPath) {
  try {
    const data = JSON.parse(fs.readFileSync(lidMapPath(sessionPath), 'utf8'));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveLidMap(sessionPath, map) {
  try {
    fs.writeFileSync(lidMapPath(sessionPath), JSON.stringify(Object.fromEntries(map)));
  } catch (err) {
    console.error('[lid-map] Error guardando:', err.message);
  }
}

async function guardarInteraccion(vendedorId, numeroProspecto, texto, esEntrante, analisis = null, prospectoNombre = null) {
  try {
    const response = await fetch(`${EDGE_FUNCTION_BASE}/guardar-mensaje`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendedor_id: vendedorId,
        prospecto_numero: numeroProspecto,
        texto: texto,
        direccion: esEntrante ? 'entrante' : 'saliente',
        prospecto_nombre: prospectoNombre,
        analisis_claude: analisis
      })
    });

    const result = await response.json();

    if (result.success) {
      console.log(`✅ Interacción guardada | ${vendedorId} | ${numeroProspecto}`);
    } else {
      console.error('❌ Error al guardar interacción:', result);
    }
  } catch (error) {
    console.error('❌ Error guardando interacción:', error);
  }
}

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
  if (existente && existente.estado === 'connected') {
    appLogger.info(`Sesión supervisor ${vendedorId} ya está conectada`);
    return;
  }

  const sessionPath = path.join(SESSIONS_DIR, `supervisor-${vendedorId}`);
  fs.mkdirSync(sessionPath, { recursive: true });

  sesiones.set(vendedorId, {
    estado: 'iniciando',
    qr: null,
    reintentos: existente ? existente.reintentos : 0,
    socket: null,
    conectadoEn: null,
    lidToPhone: existente?.lidToPhone || new Map()
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

    // lid → real phone (digits only). Persisted to disk so it survives redeploys.
    const lidToPhone = loadLidMap(sessionPath);
    sesion.lidToPhone = lidToPhone;
    console.log(`[lid-map] ${vendedorId} | cargado desde disco: ${lidToPhone.size} entradas`);

    function addLidMapping(lid, phoneJid) {
      const phone = phoneJid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
      if (!lidToPhone.has(lid)) {
        lidToPhone.set(lid, phone);
        saveLidMap(sessionPath, lidToPhone);
        console.log(`[lid-map] ${vendedorId} | nuevo: ${lid} → ${phone} (total: ${lidToPhone.size})`);
      }
    }

    // Guardar credenciales
    sock.ev.on('creds.update', saveCreds);

    // Contacts sync: fires on initial connection with ALL contacts
    const handleContacts = (contacts) => {
      let mapped = 0;
      for (const c of contacts) {
        // Standard format: c.id = phone JID, c.lid = @lid JID
        if (c.lid && c.id && (c.id.endsWith('@s.whatsapp.net') || c.id.endsWith('@c.us'))) {
          addLidMapping(c.lid, c.id);
          mapped++;
        }
        // Reverse format: c.id = @lid JID, check for phone in other fields
        if (c.id && c.id.endsWith('@lid') && c.notify) {
          console.log(`[contacts] @lid sin teléfono: ${c.id} notify=${c.notify}`);
        }
      }
      console.log(`[contacts] ${vendedorId} | recibidos=${contacts.length} mapeados=${mapped} total=${lidToPhone.size}`);
      // Debug: log first contact structure to understand available fields
      if (contacts.length > 0) {
        console.log(`[contacts] sample:`, JSON.stringify(contacts[0]));
      }
    };
    sock.ev.on('contacts.upsert', handleContacts);
    sock.ev.on('contacts.update', handleContacts);

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

        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue;

        const texto = extraerTexto(msg.message);
        if (!texto) continue;

        const direccion = msg.key.fromMe ? 'saliente' : 'entrante';

        // Resolve real phone number from JID
        let prospecto_numero;
        if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
          prospecto_numero = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
        } else if (jid.endsWith('@lid')) {
          // Try every known field that might carry the real phone
          const candidatos = [
            msg.key.senderPn,
            msg.key.participant,
            msg.participant,
          ].filter(v => v && (v.endsWith('@s.whatsapp.net') || v.endsWith('@c.us')));

          if (candidatos.length > 0) {
            addLidMapping(jid, candidatos[0]);
            prospecto_numero = lidToPhone.get(jid);
          } else {
            prospecto_numero = lidToPhone.get(jid) || null;
          }

          if (!prospecto_numero) {
            console.log(`[lid-map] ⚠️ @lid sin mapeo — registrar con:`);
            console.log(`[lid-map]   POST /api/sesion/${vendedorId}/registrar-lid`);
            console.log(`[lid-map]   Body: { "lid": "${jid.replace('@lid','')}", "phone": "NUMERO_DEL_CLIENTE" }`);
          }
        }

        console.log(`[upsert] from=${msg.key.fromMe} jid=${jid} prospecto=${prospecto_numero} dir=${direccion}`);

        if (!prospecto_numero) {
          console.log(`[upsert] ⚠️ No se pudo resolver número para ${jid} — ignorando`);
          continue;
        }

        try {
          let analisis = null;
          if (!msg.key.fromMe) {
            try {
              analisis = await analizarMensaje(texto);
            } catch (err) {
              appLogger.warn({ err }, `Error analizando mensaje de ${prospecto_numero}`);
            }
          }
          const prospecto_nombre = msg.key.fromMe ? null : (msg.pushName || null);
          await guardarInteraccion(vendedorId, prospecto_numero, texto, !msg.key.fromMe, analisis, prospecto_nombre);
          appLogger.info(`💾 Guardado | ${vendedorId} | ${direccion} | ${prospecto_numero}`);
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

  const sessionPath = path.join(SESSIONS_DIR, `supervisor-${vendedorId}`);
  fs.rmSync(sessionPath, { recursive: true, force: true });
  appLogger.info(`🗑️ Carpeta de sesión eliminada: ${sessionPath}`);
}

async function limpiarTodasLasSesionesSupervisores() {
  const appLogger = global.logger;
  appLogger.info('🧹 Limpiando TODAS las sesiones de supervisores...');

  // Cerrar todos los sockets activos
  for (const [vendedorId, sesion] of sesiones.entries()) {
    if (sesion?.socket) {
      try { sesion.socket.end(new Error('limpieza total')); } catch (_) {}
    }
    appLogger.info(`  ↳ Sesión cerrada en memoria: ${vendedorId}`);
  }
  sesiones.clear();

  // Eliminar todas las carpetas supervisor-* del disco
  if (fs.existsSync(SESSIONS_DIR)) {
    const carpetas = fs.readdirSync(SESSIONS_DIR).filter(d => d.startsWith('supervisor-'));
    for (const carpeta of carpetas) {
      const carpetaPath = path.join(SESSIONS_DIR, carpeta);
      fs.rmSync(carpetaPath, { recursive: true, force: true });
      appLogger.info(`  ↳ Carpeta eliminada: ${carpetaPath}`);
    }
    appLogger.info(`🗑️ ${carpetas.length} carpeta(s) de supervisor eliminadas`);
  }
}

/**
 * Registra manualmente un mapeo @lid → phone para una sesión.
 * Persiste en disco y aplica de inmediato para mensajes futuros.
 */
function registrarLid(vendedorId, lid, phone) {
  const sessionPath = path.join(SESSIONS_DIR, `supervisor-${vendedorId}`);
  const sesion = sesiones.get(vendedorId);

  // Normalizar: aceptar con o sin sufijo @lid
  const lidKey = lid.endsWith('@lid') ? lid : `${lid}@lid`;
  const phoneClean = phone.replace(/\D/g, '');

  // Actualizar mapa en memoria si la sesión está activa
  if (sesion?.lidToPhone) {
    sesion.lidToPhone.set(lidKey, phoneClean);
  }

  // Persistir en disco (también funciona si la sesión no está activa aún)
  const map = loadLidMap(sessionPath);
  map.set(lidKey, phoneClean);
  fs.mkdirSync(sessionPath, { recursive: true });
  saveLidMap(sessionPath, map);

  console.log(`[lid-map] Registrado manualmente: ${lidKey} → ${phoneClean}`);
  return { lid: lidKey, phone: phoneClean };
}

module.exports = {
  iniciarSesionSupervisor,
  reiniciarSesionSupervisor,
  cerrarSesionSupervisor,
  limpiarSesionSupervisor,
  limpiarTodasLasSesionesSupervisores,
  getSesionesActivas,
  getEstadoSesion,
  getQRSesion,
  registrarLid
};
