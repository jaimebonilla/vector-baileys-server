'use strict';

const BOT_SECRET = process.env.RAILWAY_BOT_SECRET;
if (!BOT_SECRET) {
  throw new Error('RAILWAY_BOT_SECRET es requerida — configúrala en las variables de entorno de Railway');
}

const PROXY_BASE = 'https://vqlesrbrrxscydvjjeux.supabase.co/functions/v1/railway-proxy';

function botHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Bot-Secret': BOT_SECRET
  };
}

async function callProxy(endpoint, body) {
  return fetch(`${PROXY_BASE}/${endpoint}`, {
    method: 'POST',
    headers: botHeaders(),
    body: JSON.stringify(body)
  });
}

/**
 * Guarda un mensaje vía edge function railway-proxy/guardar-mensaje.
 */
async function guardarMensaje({ vendedor_id, prospecto_numero, texto, esEntrante, analisis_claude = null, prospecto_nombre = null }) {
  const res = await callProxy('guardar-mensaje', {
    vendedor_id,
    prospecto_numero,
    texto,
    direccion: esEntrante ? 'entrante' : 'saliente',
    prospecto_nombre,
    analisis_claude
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || 'Error guardando mensaje');
  return result;
}

/**
 * Crea una alerta vía edge function railway-proxy/crear-alerta.
 */
async function crearAlerta({ vendedor_id, tipo, mensaje }) {
  const res = await callProxy('crear-alerta', { vendedor_id, tipo, mensaje });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || 'Error creando alerta');
  return result;
}

/**
 * Consulta conversaciones/clientes vía edge function railway-proxy/consultar-conversaciones.
 * Throws on non-OK HTTP response.
 */
async function consultarConversaciones(vendedor_id) {
  const res = await callProxy('consultar-conversaciones', { vendedor_id });
  if (!res.ok) throw new Error(`consultar-conversaciones ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Resuelve un @lid a teléfono vía edge function railway-proxy/buscar-prospecto-por-lid.
 * Returns null if the proxy returns a non-OK status (not found).
 */
async function buscarProspectoPorLid(lid, vendedor_id) {
  const res = await callProxy('buscar-prospecto-por-lid', { lid, vendedor_id });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Obtiene empresas activas vía LOVABLE_EDGE_URL/empresas-activas.
 * @param {string} edgeUrl - Value of LOVABLE_EDGE_URL env var (caller must check it's set).
 * Throws on non-OK HTTP response.
 */
async function obtenerEmpresasActivas(edgeUrl) {
  const res = await fetch(`${edgeUrl}/empresas-activas`, {
    headers: { 'X-Bot-Secret': BOT_SECRET }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = {
  guardarMensaje,
  crearAlerta,
  consultarConversaciones,
  buscarProspectoPorLid,
  obtenerEmpresasActivas
};
