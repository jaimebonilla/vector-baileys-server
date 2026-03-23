const express = require('express');
const router = express.Router();
const { enviarMensajeBotCentral, getEstadoBotCentral } = require('../sessions/bot-central');
const { getSesionesActivas } = require('../sessions/supervisor');
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

module.exports = router;
