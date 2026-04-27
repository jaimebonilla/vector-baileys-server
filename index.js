require('dotenv').config();

const express = require('express');
const pino = require('pino');

const { getSesionesActivas } = require('./sessions/supervisor');
const { iniciarBotCentral } = require('./sessions/bot-central');
const qrRoutes = require('./routes/qr');
const apiRoutes = require('./routes/api');
const { iniciarCronAlertas } = require('./services/alertas');

// Logger
const logger = pino({
  level: 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined
});

global.logger = logger;

const app = express();
app.use(express.json());

// CORS básico para Lovable
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check - responde inmediatamente, independiente de Baileys
app.get('/api/health', (req, res) => {
  const sesiones = getSesionesActivas();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    sesiones: {
      supervisores: sesiones.supervisores,
      botCentral: sesiones.botCentral
    }
  });
});

// Rutas
app.use('/api', qrRoutes);
app.use('/api', apiRoutes);

// Arrancar HTTP primero, SIEMPRE
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`✅ Servidor HTTP activo en puerto ${PORT}`);
  logger.info(`   Health: http://localhost:${PORT}/api/health`);

  // Iniciar Baileys después, sin bloquear HTTP
  iniciarBaileys();
});

async function obtenerEmpresasActivas() {
  const edgeUrl = process.env.LOVABLE_EDGE_URL;
  if (!edgeUrl) {
    logger.warn('⚠️  LOVABLE_EDGE_URL no configurada — no se cargará ninguna empresa');
    return [];
  }

  const MAX_INTENTOS = 3;
  const DELAY_MS = 5000;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      logger.info(`🌐 Cargando empresas activas desde Lovable Cloud (intento ${intento}/${MAX_INTENTOS})...`);
      const res = await fetch(`${edgeUrl}/empresas-activas`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const empresas = await res.json();
      if (!Array.isArray(empresas)) throw new Error('Respuesta inesperada: se esperaba un array');
      logger.info(`✅ ${empresas.length} empresa(s) cargadas: ${empresas.map(e => e.slug).join(', ')}`);
      return empresas;
    } catch (err) {
      logger.error({ err }, `❌ Error cargando empresas (intento ${intento}/${MAX_INTENTOS})`);
      if (intento < MAX_INTENTOS) {
        logger.info(`⏳ Reintentando en ${DELAY_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }
  }

  logger.warn('⚠️  No se pudieron cargar empresas tras todos los intentos — no se iniciará ningún Bot Central');
  return [];
}

async function iniciarBaileys() {
  // Cargar empresas dinámicamente desde Lovable Cloud
  const empresas = await obtenerEmpresasActivas();

  if (empresas.length > 0) {
    logger.info(`🔌 Iniciando Bot Central para ${empresas.length} empresa(s)...`);
    for (const { slug } of empresas) {
      try {
        await iniciarBotCentral(slug);
      } catch (err) {
        logger.error({ err }, `❌ Error al iniciar Bot Central "${slug}" - el servidor sigue activo`);
      }
    }
  }

  // Las sesiones de supervisores se crean on-demand vía POST /api/sesion/:vendedorId

  // Cron de alertas
  try {
    iniciarCronAlertas();
    logger.info('⏰ Motor de alertas iniciado');
  } catch (err) {
    logger.error({ err }, '❌ Error al iniciar cron de alertas');
  }

  logger.info('💡 Servidor listo — sesiones de supervisores se crean on-demand');
}

module.exports = app;
