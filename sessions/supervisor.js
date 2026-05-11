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

/**
 * Consulta la tabla `clientes` (todos los activos con teléfono),
 * llama a sock.onWhatsApp() para cada uno y, si WhatsApp responde con un
 * JID @lid (Privacy Mode), guarda el mapeo lid → teléfono en disco.
 * Usa SERVICE_KEY que bypass RLS — cubre clientes nuevos que aún no tienen conversación.
 */
async function autoMapearLids(vendedorId, sock, lidToPhone, sessionPath) {
  try {
    // Usar el proxy de Lovable para obtener los teléfonos de clientes
    // (clientes está en un schema no-público, no accesible via REST directo)
    console.log(`[lid-auto] ${vendedorId} | consultando clientes via proxy...`);
    const res = await fetch(`${EDGE_FUNCTION_BASE}/consultar-conversaciones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendedor_id: vendedorId })
    });
    if (!res.ok) throw new Error(`Proxy consultar-conversaciones ${res.status}: ${await res.text()}`);
    const rawData = await res.json();
    console.log(`[lid-auto] ${vendedorId} | respuesta proxy (primeros 2):`, JSON.stringify(Array.isArray(rawData) ? rawData.slice(0, 2) : rawData));

    // El proxy puede devolver array directo o { clientes: [...] } o { data: [...] }
    const rows = Array.isArray(rawData) ? rawData
      : Array.isArray(rawData?.clientes) ? rawData.clientes
      : Array.isArray(rawData?.data) ? rawData.data
      : [];

    // Aceptar campo telefono o prospecto_numero
    const telefonos = [...new Set(
      rows.map(r => r.telefono || r.prospecto_numero || r.phone || r.numero).filter(Boolean)
    )];
    console.log(`[lid-auto] ${vendedorId} | teléfonos extraídos: ${telefonos.length} → [${telefonos.join(', ')}]`);
    if (telefonos.length === 0) {
      console.log(`[lid-auto] ${vendedorId} | sin clientes con teléfono activos`);
      return;
    }

    const BATCH = 50;
    let nuevos = 0;
    for (let i = 0; i < telefonos.length; i += BATCH) {
      const lote = telefonos.slice(i, i + BATCH);
      try {
        console.log(`[lid-auto] ${vendedorId} | llamando onWhatsApp con: [${lote.join(', ')}]`);
        const results = await sock.onWhatsApp(...lote);
        console.log(`[lid-auto] ${vendedorId} | resultado onWhatsApp:`, JSON.stringify(results));

        for (const r of (results || [])) {
          if (!r?.exists || !r.jid) continue;

          const phone = r.jid
            .replace(/@s\.whatsapp\.net$/, '')
            .replace(/@c\.us$/, '')
            .replace(/\D/g, '');
          if (!phone) continue;

          if (!lidToPhone.has(r.jid)) {
            lidToPhone.set(r.jid, phone);
            nuevos++;
          }
          if (r.lid && r.lid !== r.jid && !lidToPhone.has(r.lid)) {
            lidToPhone.set(r.lid, phone);
            nuevos++;
            console.log(`[lid-auto] ✅ ${vendedorId} | ${r.lid} → ${phone}`);
          }
        }
      } catch (batchErr) {
        console.log(`[lid-auto] ${vendedorId} | Error en lote:`, batchErr.message);
      }
    }

    if (nuevos > 0) saveLidMap(sessionPath, lidToPhone);
    console.log(`[lid-auto] ${vendedorId} | DONE mapeados=${nuevos} total=${lidToPhone.size} mapa:`, JSON.stringify(Object.fromEntries(lidToPhone)));
  } catch (err) {
    console.log(`[lid-auto] ${vendedorId} | Error:`, err.message);
  }
}

/**
 * Fallback: cuando un @lid no está en el mapa local, pregunta al proxy de Lovable.
 * El proxy busca en su tabla de clientes por el lid y devuelve el teléfono si lo encuentra.
 * @returns {string|null} teléfono solo dígitos, o null si no encontrado
 */
async function resolverLidViaProxy(lid, vendedorId) {
  try {
    const lidSinSufijo = lid.replace(/@lid$/, '');
    const res = await fetch(`${EDGE_FUNCTION_BASE}/buscar-prospecto-por-lid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lid: lidSinSufijo, vendedor_id: vendedorId })
    });
    if (!res.ok) {
      console.log(`[lid-proxy] ${vendedorId} | proxy respondió ${res.status} para ${lid}`);
      return null;
    }
    const data = await res.json();
    // Aceptar cualquier campo razonable que devuelva el proxy
    const telefono = data?.telefono || data?.phone || data?.prospecto_numero || data?.numero || null;
    if (telefono) {
      console.log(`[lid-proxy] ${vendedorId} | ${lid} → ${telefono} (via proxy)`);
    } else {
      console.log(`[lid-proxy] ${vendedorId} | proxy no encontró mapeo para ${lid}:`, JSON.stringify(data));
    }
    return telefono ? String(telefono).replace(/\D/g, '') : null;
  } catch (err) {
    console.log(`[lid-proxy] ${vendedorId} | error consultando proxy para ${lid}:`, err.message);
    return null;
  }
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
    console.log(`[lid-map] ${vendedorId} | cargado desde disco: ${lidToPhone.size} entradas`, JSON.stringify(Object.fromEntries(lidToPhone)));

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

    // WhatsApp a veces envía el mapeo lid ↔ teléfono como evento explícito
    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      if (lid && jid) {
        const phone = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
        if (!lidToPhone.has(lid)) {
          lidToPhone.set(lid, phone);
          saveLidMap(sessionPath, lidToPhone);
          console.log(`[lid-map] phoneNumberShare: ${lid} → ${phone}`);
        }
      }
    });

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

        // Auto-mapear @lid ↔ teléfono consultando los clientes registrados en Supabase
        setTimeout(() => autoMapearLids(vendedorId, sock, lidToPhone, sessionPath), 3000);
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
          // 1. senderPn: hint del teléfono real, solo en mensajes entrantes
          const senderPn = msg.key.senderPn;
          if (senderPn) {
            const phone = senderPn.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '').replace(/\D/g, '');
            if (phone) addLidMapping(jid, phone);
          }

          // 2. Mapa local (cargado de disco, llenado por autoMapearLids o senderPn)
          prospecto_numero = lidToPhone.get(jid) || null;

          if (!prospecto_numero) {
            console.log(`[lid-map] ${vendedorId} | @lid sin mapeo: ${jid}`);
            console.log(`[lid-map] ${vendedorId} | mapa actual (${lidToPhone.size} entradas):`, JSON.stringify(Object.fromEntries(lidToPhone)));
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
