const express = require('express');
const router = express.Router();
const { enviarMensajeBotCentral, getEstadoBotCentral, reiniciarBotCentral, limpiarSesionBotCentral, iniciarBotCentral, getAllBotCentrales } = require('../sessions/bot-central');
const { getSesionesActivas, reiniciarSesionSupervisor, limpiarSesionSupervisor, limpiarTodasLasSesionesSupervisores, registrarLid } = require('../sessions/supervisor');
const { obtenerAlertas, marcarAlertaEnviada } = require('../services/supabase');

/**
 * POST /api/enviar
 * Envía un mensaje desde el Bot Central de una empresa.
 * Body: { numero: "5219991234567", mensaje: "Hola...", slug: "alianza_capitales" }
 */
router.post('/enviar', async (req, res) => {
  const logger = global.logger;
  const { numero, mensaje, slug } = req.body;

  if (!numero || !mensaje) {
    return res.status(400).json({ error: 'Faltan campos: numero, mensaje' });
  }

  if (getEstadoBotCentral(slug) !== 'connected') {
    return res.status(503).json({
      error: `Bot Central${slug ? ` "${slug}"` : ''} no está conectado`,
      estado: getEstadoBotCentral(slug)
    });
  }

  try {
    await enviarMensajeBotCentral(numero, mensaje, slug);
    logger.info(`Mensaje enviado a ${numero} via Bot Central${slug ? ` (${slug})` : ''}`);
    res.json({ ok: true, numero, slug: slug || null, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, `Error enviando mensaje a ${numero}`);
    res.status(500).json({ error: 'Error al enviar mensaje', detalle: err.message });
  }
});

/**
 * GET /api/sesiones
 * Lista el estado de todas las sesiones activas (bot-centrales + supervisores).
 */
router.get('/sesiones', (req, res) => {
  const sesiones = getSesionesActivas();
  const botCentralesList = getAllBotCentrales();

  res.json({
    botCentrales: botCentralesList.length > 0 ? botCentralesList : [],
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
 * Reinicia una sesión detenida.
 * sessionId puede ser "bot-central-{slug}" o un vendedor_id.
 */
router.post('/sesion/:sessionId/reiniciar', async (req, res) => {
  const logger = global.logger;
  const { sessionId } = req.params;

  try {
    if (sessionId.startsWith('bot-central-')) {
      const slug = sessionId.slice('bot-central-'.length);
      await reiniciarBotCentral(slug);
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
 * sessionId puede ser "bot-central-{slug}" o un vendedor_id.
 */
router.delete('/sesion/:sessionId/limpiar', async (req, res) => {
  const logger = global.logger;
  const { sessionId } = req.params;

  try {
    if (sessionId.startsWith('bot-central-')) {
      const slug = sessionId.slice('bot-central-'.length);
      await limpiarSesionBotCentral(slug);
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

/**
 * POST /api/bot-central/:slug/iniciar
 * Arranca un bot-central para una empresa específica.
 */
router.post('/bot-central/:slug/iniciar', async (req, res) => {
  const logger = global.logger;
  const { slug } = req.params;

  try {
    iniciarBotCentral(slug).catch(err => {
      logger.error({ err }, `Error iniciando Bot Central ${slug}`);
    });
    logger.info(`🤖 Bot Central "${slug}" iniciado via API`);
    res.json({
      success: true,
      message: `Bot Central "${slug}" iniciado. Consulta /api/qr/bot-central-${slug} para el QR.`,
      sessionId: `bot-central-${slug}`
    });
  } catch (err) {
    logger.error({ err }, `Error en POST /api/bot-central/${slug}/iniciar`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/bot-central/:slug/detener
 * Detiene y limpia el bot-central de una empresa.
 */
router.delete('/bot-central/:slug/detener', async (req, res) => {
  const logger = global.logger;
  const { slug } = req.params;

  try {
    await limpiarSesionBotCentral(slug);
    logger.info(`🛑 Bot Central "${slug}" detenido via API`);
    res.json({ success: true, message: `Bot Central "${slug}" detenido y sesión eliminada.` });
  } catch (err) {
    logger.error({ err }, `Error en DELETE /api/bot-central/${slug}/detener`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sesion/:vendedorId/registrar-lid
 * Registra manualmente un mapeo @lid → teléfono real para contactos en WhatsApp Privacy Mode.
 * Solo se necesita hacer una vez por contacto — el mapeo se persiste en disco.
 * Body: { "lid": "43735786217544", "phone": "50660020956" }
 */
router.post('/sesion/:vendedorId/registrar-lid', (req, res) => {
  const { vendedorId } = req.params;
  const { lid, phone } = req.body;

  if (!lid || !phone) {
    return res.status(400).json({ error: 'Faltan campos: lid, phone' });
  }

  try {
    const result = registrarLid(vendedorId, lid, phone);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
