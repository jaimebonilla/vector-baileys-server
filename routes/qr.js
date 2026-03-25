const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getEstadoSesion, getQRSesion, iniciarSesionSupervisor, reiniciarSesionSupervisor } = require('../sessions/supervisor');
const { getEstadoBotCentral, getQRBotCentral, reiniciarBotCentral } = require('../sessions/bot-central');

function obtenerEstadoYQR(sessionId) {
  if (sessionId === 'bot-central') {
    return { estado: getEstadoBotCentral(), qrString: getQRBotCentral() };
  }
  return { estado: getEstadoSesion(sessionId), qrString: getQRSesion(sessionId) };
}

/**
 * GET /api/qr/:sessionId
 * Devuelve el QR como imagen base64 o el estado de conexión.
 * sessionId puede ser "bot-central" o el ID de un vendedor supervisor.
 */
router.get('/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const logger = global.logger;

  try {
    let { estado, qrString } = obtenerEstadoYQR(sessionId);

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

    // Si está detenida, reiniciar automáticamente y esperar QR
    if (estado === 'stopped') {
      console.log(`Sesión ${sessionId} detenida, reiniciando automáticamente...`);
      if (sessionId === 'bot-central') {
        await reiniciarBotCentral();
      } else {
        await reiniciarSesionSupervisor(sessionId);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      const actualizado = obtenerEstadoYQR(sessionId);
      estado = actualizado.estado;
      qrString = actualizado.qrString;
    }

    // Si ya está conectado
    if (estado === 'connected') {
      return res.json({ sessionId, status: 'connected', qr: null });
    }

    // Si hay QR disponible, convertirlo a base64
    if (qrString) {
      try {
        const qrBase64 = await QRCode.toDataURL(qrString);
        return res.json({ sessionId, status: 'waiting_qr', qr: qrBase64 });
      } catch (qrErr) {
        logger.error({ qrErr }, 'Error al generar imagen QR');
        return res.json({ sessionId, status: 'waiting_qr', qr: null, qrRaw: qrString });
      }
    }

    // Estado intermedio (conectando, reconectando, etc.)
    return res.json({ sessionId, status: estado, qr: null });

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
