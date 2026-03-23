const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getEstadoSesion, getQRSesion, iniciarSesionSupervisor } = require('../sessions/supervisor');
const { getEstadoBotCentral, getQRBotCentral } = require('../sessions/bot-central');

/**
 * GET /api/qr/:sessionId
 * Devuelve el QR como imagen base64 o el estado de conexión.
 * sessionId puede ser "bot-central" o el ID de un vendedor supervisor.
 */
router.get('/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const logger = global.logger;

  try {
    let estado, qrString;

    if (sessionId === 'bot-central') {
      estado = getEstadoBotCentral();
      qrString = getQRBotCentral();
    } else {
      estado = getEstadoSesion(sessionId);
      qrString = getQRSesion(sessionId);
    }

    // Si no existe la sesión aún
    if (!estado) {
      return res.status(404).json({
        sessionId,
        status: 'no_iniciada',
        mensaje: sessionId === 'bot-central'
          ? 'Bot Central no iniciado'
          : `Sesión supervisor "${sessionId}" no encontrada. Usa POST /api/sesion/${sessionId} para crearla.`
      });
    }

    // Si ya está conectado
    if (estado === 'conectado') {
      return res.json({
        sessionId,
        status: 'conectado',
        qr: null
      });
    }

    // Si hay QR disponible, convertirlo a base64
    if (qrString) {
      try {
        const qrBase64 = await QRCode.toDataURL(qrString);
        return res.json({
          sessionId,
          status: 'esperando_qr',
          qr: qrBase64
        });
      } catch (qrErr) {
        logger.error({ qrErr }, 'Error al generar imagen QR');
        return res.json({
          sessionId,
          status: 'esperando_qr',
          qr: null,
          qrRaw: qrString
        });
      }
    }

    // Estado intermedio (conectando, reconectando, etc.)
    return res.json({
      sessionId,
      status: estado,
      qr: null
    });

  } catch (err) {
    logger.error({ err }, `Error en GET /api/qr/${sessionId}`);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

/**
 * POST /api/sesion/:vendedorId
 * Inicia una nueva sesión supervisor para un vendedor.
 */
router.post('/sesion/:vendedorId', async (req, res) => {
  const { vendedorId } = req.params;
  const logger = global.logger;

  if (!vendedorId || vendedorId === 'bot-central') {
    return res.status(400).json({ error: 'ID de vendedor inválido' });
  }

  try {
    logger.info(`Iniciando sesión supervisor para vendedor: ${vendedorId}`);
    // No esperamos a que se conecte, solo iniciamos el proceso
    iniciarSesionSupervisor(vendedorId).catch(err => {
      logger.error({ err }, `Error iniciando sesión supervisor ${vendedorId}`);
    });

    res.json({
      mensaje: `Sesión supervisor para "${vendedorId}" iniciada. Consulta /api/qr/${vendedorId} para obtener el QR.`,
      sessionId: vendedorId
    });
  } catch (err) {
    logger.error({ err }, `Error en POST /api/sesion/${vendedorId}`);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

/**
 * DELETE /api/sesion/:vendedorId
 * Cierra y elimina una sesión supervisor.
 */
router.delete('/sesion/:vendedorId', async (req, res) => {
  const { vendedorId } = req.params;
  const { cerrarSesionSupervisor } = require('../sessions/supervisor');
  const logger = global.logger;

  try {
    await cerrarSesionSupervisor(vendedorId);
    res.json({ mensaje: `Sesión "${vendedorId}" cerrada` });
  } catch (err) {
    logger.error({ err }, `Error cerrando sesión ${vendedorId}`);
    res.status(500).json({ error: 'Error al cerrar sesión' });
  }
});

module.exports = router;
