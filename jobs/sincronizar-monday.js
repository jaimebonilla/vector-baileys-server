const MondayConnector = require('../services/monday-connector');

let sincronizacionEnCurso = false;

async function ejecutarSincronizacion() {
  if (sincronizacionEnCurso) {
    console.log('⏭️ Sincronización ya en curso, saltando...');
    return;
  }

  sincronizacionEnCurso = true;

  try {
    const connector = new MondayConnector();
    await connector.sincronizarTodos();
  } catch (error) {
    console.error('❌ Error en job de sincronización:', error);
  } finally {
    sincronizacionEnCurso = false;
  }
}

// Ejecutar al iniciar (con delay de 30 segundos)
setTimeout(() => {
  console.log('🚀 Ejecutando sincronización inicial de Monday...');
  ejecutarSincronizacion();
}, 30000);

// Ejecutar cada 10 minutos
setInterval(() => {
  console.log('🔄 Sincronización periódica de Monday...');
  ejecutarSincronizacion();
}, 10 * 60 * 1000);

module.exports = { ejecutarSincronizacion };
