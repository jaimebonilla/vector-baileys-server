const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function getSupabase() {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL y SUPABASE_SERVICE_KEY son requeridas');
    }
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return supabase;
}

/**
 * Obtiene o crea una conversación para un vendedor y prospecto.
 * @param {string} vendedorId
 * @param {string} prospectoNumero
 * @returns {string} ID de la conversación
 */
async function obtenerOCrearConversacion(vendedorId, prospectoNumero) {
  const db = getSupabase();

  // Buscar conversación existente
  const { data: existente, error: errBusqueda } = await db
    .from('conversaciones')
    .select('id')
    .eq('vendedor_id', vendedorId)
    .eq('prospecto_numero', prospectoNumero)
    .single();

  if (errBusqueda && errBusqueda.code !== 'PGRST116') { // PGRST116 = not found
    throw errBusqueda;
  }

  if (existente) {
    // Actualizar última actividad
    await db
      .from('conversaciones')
      .update({ ultima_actividad: new Date().toISOString() })
      .eq('id', existente.id);

    return existente.id;
  }

  // Crear nueva conversación
  const { data: nueva, error: errCrear } = await db
    .from('conversaciones')
    .insert({
      vendedor_id: vendedorId,
      prospecto_numero: prospectoNumero,
      ultima_actividad: new Date().toISOString()
    })
    .select('id')
    .single();

  if (errCrear) throw errCrear;

  return nueva.id;
}

/**
 * Guarda un mensaje vía Edge Function proxy.
 * @param {string} vendedorId
 * @param {string} prospectoNumero
 * @param {string} texto
 * @param {boolean} esEntrante
 * @param {object|null} analisis
 */
async function guardarMensaje(vendedorId, prospectoNumero, texto, esEntrante, analisis) {
  const response = await fetch(
    'https://vqlesrbrrxscydvjjeux.supabase.co/functions/v1/railway-proxy/guardar-mensaje',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendedor_id: vendedorId,
        prospecto_numero: prospectoNumero,
        texto: texto,
        direccion: esEntrante ? 'entrante' : 'saliente',
        analisis_claude: analisis
      })
    }
  );

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Error guardando mensaje');
  }

  console.log('✅ Mensaje guardado:', result);
  return result;
}

/**
 * Obtiene el contexto completo de un vendedor para el Bot Central.
 * @param {string} vendedorId
 * @returns {string} Contexto formateado en texto
 */
async function obtenerContextoVendedor(vendedorId) {
  const db = getSupabase();

  // Obtener conversaciones del vendedor
  const { data: conversaciones, error: errConv } = await db
    .from('conversaciones')
    .select('id, prospecto_numero, ultima_actividad')
    .eq('vendedor_id', vendedorId)
    .order('ultima_actividad', { ascending: false })
    .limit(10);

  if (errConv) throw errConv;

  if (!conversaciones || conversaciones.length === 0) {
    return `El vendedor ${vendedorId} no tiene conversaciones registradas.`;
  }

  const threshold = parseInt(process.env.ALERT_THRESHOLD_DAYS || '3', 10);
  const ahora = new Date();

  let contexto = `Vendedor: ${vendedorId}\nConversaciones activas: ${conversaciones.length}\n\n`;

  for (const conv of conversaciones) {
    const diasInactivo = Math.floor(
      (ahora - new Date(conv.ultima_actividad)) / (1000 * 60 * 60 * 24)
    );

    const alerta = diasInactivo >= threshold ? ` ⚠️ INACTIVO ${diasInactivo} días` : '';
    contexto += `• Prospecto ${conv.prospecto_numero}: última actividad ${diasInactivo} días${alerta}\n`;

    // Obtener últimos 3 mensajes de esta conversación
    const { data: mensajes } = await db
      .from('mensajes')
      .select('texto, direccion, analisis_claude, timestamp')
      .eq('conversacion_id', conv.id)
      .order('timestamp', { ascending: false })
      .limit(3);

    if (mensajes && mensajes.length > 0) {
      for (const m of mensajes.reverse()) {
        const dir = m.direccion === 'entrante' ? '←' : '→';
        contexto += `  ${dir} "${m.texto?.substring(0, 80)}"\n`;
        if (m.analisis_claude?.siguiente_accion_sugerida) {
          contexto += `     💡 Sugerido: ${m.analisis_claude.siguiente_accion_sugerida}\n`;
        }
      }
    }
    contexto += '\n';
  }

  return contexto;
}

/**
 * Crea una alerta en Supabase.
 */
async function crearAlerta({ vendedor_id, tipo, mensaje }) {
  const db = getSupabase();

  const { error } = await db
    .from('alertas')
    .insert({
      vendedor_id,
      tipo,
      mensaje,
      enviada_at: null
    });

  if (error) throw error;
}

/**
 * Obtiene alertas (filtradas por estado enviada).
 */
async function obtenerAlertas({ enviada = false } = {}) {
  const db = getSupabase();

  let query = db
    .from('alertas')
    .select('*')
    .order('created_at', { ascending: false });

  if (!enviada) {
    query = query.is('enviada_at', null);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Marca una alerta como enviada.
 */
async function marcarAlertaEnviada(alertaId) {
  const db = getSupabase();

  const { error } = await db
    .from('alertas')
    .update({ enviada_at: new Date().toISOString() })
    .eq('id', alertaId);

  if (error) throw error;
}

/**
 * Obtiene conversaciones con inactividad mayor al threshold configurado.
 */
async function obtenerConversacionesInactivas() {
  const db = getSupabase();
  const threshold = parseInt(process.env.ALERT_THRESHOLD_DAYS || '3', 10);
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() - threshold);

  const { data, error } = await db
    .from('conversaciones')
    .select('id, vendedor_id, prospecto_numero, ultima_actividad')
    .lt('ultima_actividad', fechaLimite.toISOString());

  if (error) throw error;
  return data || [];
}

module.exports = {
  obtenerOCrearConversacion,
  guardarMensaje,
  obtenerContextoVendedor,
  crearAlerta,
  obtenerAlertas,
  marcarAlertaEnviada,
  obtenerConversacionesInactivas
};
