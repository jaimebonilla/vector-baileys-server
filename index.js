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

async function iniciarBaileys() {
  logger.info('🔌 Iniciando Bot Central...');

  // Bot Central
  try {
    await iniciarBotCentral();
  } catch (err) {
    logger.error({ err }, '❌ Error al iniciar Bot Central - el servidor sigue activo');
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
