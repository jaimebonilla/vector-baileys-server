const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const MODELO = 'claude-sonnet-4-20250514';

const SYSTEM_ANALISIS = `Eres un asistente especializado en analizar conversaciones de ventas por WhatsApp.
Tu objetivo es evaluar el estado de cada conversación para ayudar a los supervisores a identificar
prospectos que necesitan atención.

Analiza el mensaje y devuelve un JSON con esta estructura exacta:
{
  "nivel_interes": "alto" | "medio" | "bajo",
  "riesgo_enfriamiento": "alto" | "medio" | "bajo",
  "urgencia": "inmediata" | "esta_semana" | "sin_urgencia",
  "siguiente_accion_sugerida": "texto breve con la acción recomendada",
  "resumen": "resumen de una línea del estado de la conversación"
}

Responde SOLO con el JSON, sin texto adicional.`;

const SYSTEM_BOT_CENTRAL = `Eres un asistente de supervisión de ventas para el sistema Vector.
Tienes acceso al contexto de las conversaciones de los vendedores con sus prospectos.
Tu rol es responder preguntas de los gerentes sobre el desempeño de sus vendedores,
analizar conversaciones y sugerir acciones concretas.

Sé directo, conciso y orientado a resultados. Usa el contexto proporcionado para dar
respuestas específicas y accionables.`;

/**
 * Analiza un mensaje de ventas y devuelve métricas estructuradas.
 * @param {string} texto - El mensaje a analizar
 * @returns {object} JSON con nivel_interes, riesgo_enfriamiento, urgencia, siguiente_accion_sugerida
 */
async function analizarMensaje(texto) {
  const appLogger = global.logger;

  try {
    const response = await client.messages.create({
      model: MODELO,
      max_tokens: 500,
      system: SYSTEM_ANALISIS,
      messages: [
        {
          role: 'user',
          content: `Analiza este mensaje de WhatsApp de un prospecto:\n\n"${texto}"`
        }
      ]
    });

    const contenido = response.content[0]?.text;
    if (!contenido) return null;

    // Extraer JSON de la respuesta
    const jsonMatch = contenido.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      appLogger.warn('Claude no devolvió JSON válido en analizarMensaje');
      return null;
    }

    return JSON.parse(jsonMatch[0]);

  } catch (err) {
    appLogger.error({ err }, 'Error llamando a Claude API (analizarMensaje)');
    throw err;
  }
}

/**
 * Genera una respuesta del Bot Central para un gerente.
 * @param {object} params
 * @param {string} params.pregunta - La pregunta del gerente
 * @param {string} params.contexto - Contexto del vendedor desde Supabase
 * @param {string|null} params.vendedorId - ID del vendedor (opcional)
 * @returns {string} Respuesta en texto para enviar por WhatsApp
 */
async function generarRespuesta({ pregunta, contexto, vendedorId }) {
  const appLogger = global.logger;

  const contextoMsg = vendedorId
    ? `Contexto del vendedor "${vendedorId}":\n${contexto}`
    : 'No se especificó vendedor. Contexto general del sistema Vector.';

  try {
    const response = await client.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: SYSTEM_BOT_CENTRAL,
      messages: [
        {
          role: 'user',
          content: `${contextoMsg}\n\nPregunta del gerente: ${pregunta}`
        }
      ]
    });

    return response.content[0]?.text || 'No pude generar una respuesta. Intenta de nuevo.';

  } catch (err) {
    appLogger.error({ err }, 'Error llamando a Claude API (generarRespuesta)');
    throw err;
  }
}

/**
 * Analiza múltiples conversaciones para generar un resumen de vendedor.
 * @param {Array} mensajes - Array de mensajes
 * @param {string} vendedorId - ID del vendedor
 * @returns {string} Resumen del desempeño
 */
async function generarResumenVendedor(mensajes, vendedorId) {
  const appLogger = global.logger;

  if (!mensajes || mensajes.length === 0) {
    return 'No hay conversaciones registradas para este vendedor.';
  }

  const resumenMensajes = mensajes
    .slice(-20) // últimos 20 mensajes
    .map(m => `[${m.direccion}] ${m.texto?.substring(0, 100)}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: MODELO,
      max_tokens: 800,
      system: SYSTEM_BOT_CENTRAL,
      messages: [
        {
          role: 'user',
          content: `Genera un resumen del desempeño del vendedor "${vendedorId}" basado en estas conversaciones recientes:\n\n${resumenMensajes}\n\nIncluye: prospectos activos, riesgos detectados y acciones recomendadas.`
        }
      ]
    });

    return response.content[0]?.text || 'No se pudo generar el resumen.';

  } catch (err) {
    appLogger.error({ err }, 'Error generando resumen de vendedor');
    throw err;
  }
}

module.exports = {
  analizarMensaje,
  generarRespuesta,
  generarResumenVendedor
};
