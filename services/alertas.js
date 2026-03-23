const cron = require('node-cron');
const { obtenerConversacionesInactivas, crearAlerta, obtenerAlertas } = require('./supabase');
const { enviarMensajeBotCentral, getEstadoBotCentral } = require('../sessions/bot-central');

/**
 * Inicia el cron job de alertas.
 * Corre cada 6 horas para detectar conversaciones inactivas.
 */
function iniciarCronAlertas() {
  const appLogger = global.logger;

  // Ejecutar cada 6 horas
  cron.schedule('0 */6 * * *', async () => {
    appLogger.info('⏰ Cron alertas: verificando conversaciones inactivas...');
    await verificarYGenerarAlertas();
  });

  // También correr al inicio después de 30 segundos
  setTimeout(async () => {
    appLogger.info('⏰ Cron alertas: verificación inicial...');
    await verificarYGenerarAlertas();
  }, 30000);

  appLogger.info('⏰ Cron de alertas configurado (cada 6 horas)');
}

/**
 * Verifica conversaciones inactivas y genera/envía alertas.
 */
async function verificarYGenerarAlertas() {
  const appLogger = global.logger;
  const threshold = parseInt(process.env.ALERT_THRESHOLD_DAYS || '3', 10);

  try {
    const conversacionesInactivas = await obtenerConversacionesInactivas();

    if (conversacionesInactivas.length === 0) {
      appLogger.info('✅ No hay conversaciones inactivas');
      return;
    }

    appLogger.info(`⚠️ ${conversacionesInactivas.length} conversaciones inactivas detectadas`);

    for (const conv of conversacionesInactivas) {
      const diasInactivo = Math.floor(
        (new Date() - new Date(conv.ultima_actividad)) / (1000 * 60 * 60 * 24)
      );

      const mensajeAlerta = `⚠️ *Alerta Vector*\n\nVendedor: ${conv.vendedor_id}\nProspecto: ${conv.prospecto_numero}\nInactivo: ${diasInactivo} días (umbral: ${threshold} días)\n\nÚltima actividad: ${new Date(conv.ultima_actividad).toLocaleString('es-MX')}`;

      // Crear alerta en BD
      try {
        await crearAlerta({
          vendedor_id: conv.vendedor_id,
          tipo: 'inactividad',
          mensaje: mensajeAlerta
        });
      } catch (err) {
        // Puede ser duplicado, ignorar
        appLogger.debug({ err }, 'Alerta posiblemente duplicada, ignorando');
      }
    }

    // Intentar enviar alertas pendientes si el Bot Central está conectado
    await enviarAlertasPendientes();

  } catch (err) {
    appLogger.error({ err }, 'Error en cron de alertas');
  }
}

/**
 * Envía alertas pendientes por WhatsApp si el Bot Central está conectado.
 */
async function enviarAlertasPendientes() {
  const appLogger = global.logger;

  if (getEstadoBotCentral() !== 'conectado') {
    appLogger.info('📵 Bot Central no conectado, alertas quedan en BD para envío posterior');
    return;
  }

  const gerentesNums = (process.env.GERENTES_NUMEROS || '').split(',').map(n => n.trim()).filter(Boolean);

  if (gerentesNums.length === 0) {
    appLogger.warn('No hay GERENTES_NUMEROS configurados para enviar alertas');
    return;
  }

  try {
    const alertasPendientes = await obtenerAlertas({ enviada: false });

    if (alertasPendientes.length === 0) return;

    appLogger.info(`📤 Enviando ${alertasPendientes.length} alertas pendientes a ${gerentesNums.length} gerente(s)`);

    for (const alerta of alertasPendientes) {
      for (const gerente of gerentesNums) {
        try {
          await enviarMensajeBotCentral(gerente, alerta.mensaje);
          appLogger.info(`✉️ Alerta enviada a gerente ${gerente}: ${alerta.tipo}`);
        } catch (err) {
          appLogger.error({ err }, `Error enviando alerta a ${gerente}`);
        }
      }

      // Marcar como enviada (importamos aquí para evitar circular dep)
      const { marcarAlertaEnviada } = require('./supabase');
      await marcarAlertaEnviada(alerta.id);
    }

  } catch (err) {
    appLogger.error({ err }, 'Error enviando alertas pendientes');
  }
}

module.exports = {
  iniciarCronAlertas,
  verificarYGenerarAlertas,
  enviarAlertasPendientes
};
