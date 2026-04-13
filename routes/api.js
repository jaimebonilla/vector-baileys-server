const express = require('express');
const router = express.Router();
const { enviarMensajeBotCentral, getEstadoBotCentral, reiniciarBotCentral, limpiarSesionBotCentral } = require('../sessions/bot-central');
const { getSesionesActivas, reiniciarSesionSupervisor, limpiarSesionSupervisor, limpiarTodasLasSesionesSupervisores } = require('../sessions/supervisor');
const { obtenerAlertas, marcarAlertaEnviada } = require('../services/supabase');

/**
 * POST /api/enviar
 * Envía un mensaje desde el Bot Central.
 * Body: { numero: "5219991234567", mensaje: "Hola..." }
 */
router.post('/enviar', async (req, res) => {
  const logger = global.logger;
  const { numero, mensaje } = req.body;

  if (!numero || !mensaje) {
    return res.status(400).json({ error: 'Faltan campos: numero, mensaje' });
  }

  if (getEstadoBotCentral() !== 'conectado') {
    return res.status(503).json({
      error: 'Bot Central no está conectado',
      estado: getEstadoBotCentral()
    });
  }

  try {
    await enviarMensajeBotCentral(numero, mensaje);
    logger.info(`Mensaje enviado a ${numero} via Bot Central`);
    res.json({ ok: true, numero, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, `Error enviando mensaje a ${numero}`);
    res.status(500).json({ error: 'Error al enviar mensaje', detalle: err.message });
  }
});

/**
 * GET /api/sesiones
 * Lista el estado de todas las sesiones activas.
 */
router.get('/sesiones', (req, res) => {
  const { getEstadoBotCentral } = require('../sessions/bot-central');
  const sesiones = getSesionesActivas();
  const botEstado = getEstadoBotCentral();

  res.json({
    botCentral: {
      estado: botEstado || 'no_iniciado',
      qrUrl: '/api/qr/bot-central'
    },
    supervisores: sesiones.supervisores.map(s => ({
      ...s,
      qrUrl: `/api/qr/${s.vendedorId}`
    }))
  });
});

/**
 * GET /api/alertas
 * Devuelve alertas pendientes de enviar.
 */
router.get('/alertas', async (req, res) => {
  const logger = global.logger;
  try {
    const alertas = await obtenerAlertas({ enviada: false });
    res.json({ alertas });
  } catch (err) {
    logger.error({ err }, 'Error obteniendo alertas');
    res.status(500).json({ error: 'Error al obtener alertas' });
  }
});

/**
 * POST /api/alertas/:id/enviada
 * Marca una alerta como enviada.
 */
router.post('/alertas/:id/enviada', async (req, res) => {
  const logger = global.logger;
  const { id } = req.params;
  try {
    await marcarAlertaEnviada(id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, `Error marcando alerta ${id} como enviada`);
    res.status(500).json({ error: 'Error al actualizar alerta' });
  }
});

/**
 * DELETE /api/sesiones/limpiar-todo
 * Elimina TODAS las sesiones de supervisores de memoria y disco.
 * Usar para resetear el servidor y crear sesiones desde cero con nuevos vendedor_id.
 */
router.delete('/sesiones/limpiar-todo', async (req, res) => {
  const logger = global.logger;
  try {
    await limpiarTodasLasSesionesSupervisores();
    logger.info('🧹 Todas las sesiones de supervisores eliminadas via API');
    res.json({ success: true, message: 'Todas las sesiones de supervisores han sido eliminadas. Crea nuevas sesiones con POST /api/sesion/:vendedorId' });
  } catch (err) {
    logger.error({ err }, 'Error al limpiar todas las sesiones');
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sesion/:sessionId/reiniciar
 * Reinicia una sesión detenida (bot-central o cualquier vendedor_id)
 */
router.post('/sesion/:sessionId/reiniciar', async (req, res) => {
  const logger = global.logger;
  const { sessionId } = req.params;

  try {
    if (sessionId === 'bot-central') {
      await reiniciarBotCentral();
    } else {
      await reiniciarSesionSupervisor(sessionId);
    }
    logger.info(`♻️ Sesión ${sessionId} reiniciada via API`);
    res.json({ success: true, message: 'Sesión reiniciada' });
  } catch (err) {
    logger.error({ err }, `Error al reiniciar sesión ${sessionId}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/sesion/:sessionId/limpiar
 * Detiene la sesión y elimina su carpeta de datos (limpieza total).
 */
router.delete('/sesion/:sessionId/limpiar', async (req, res) => {
  const logger = global.logger;
  const { sessionId } = req.params;

  try {
    if (sessionId === 'bot-central') {
      await limpiarSesionBotCentral();
    } else {
      await limpiarSesionSupervisor(sessionId);
    }
    logger.info(`🧹 Sesión ${sessionId} limpiada via API`);
    res.json({ success: true, message: 'Sesión limpiada' });
  } catch (err) {
    logger.error({ err }, `Error al limpiar sesión ${sessionId}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
