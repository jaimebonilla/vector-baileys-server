'use strict';

// slug -> { numeros: Set<string>, expiresAt: number }
const _cache = new Map();
const TTL_MS = 60_000;

/**
 * Strips WhatsApp JID suffixes and non-digit characters, returning only digits.
 */
function normalizeJid(jid) {
  return String(jid)
    .replace(/@lid$/, '')
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@c\.us$/, '')
    .replace(/\D/g, '');
}

/**
 * Returns true if sender (digits-only) matches any number in allowedSet,
 * using exact match or last-10-digits suffix matching to handle country-code variants.
 */
function matchesAllowed(sender, allowedSet) {
  if (allowedSet.has(sender)) return true;
  const senderSuffix = sender.slice(-10);
  if (senderSuffix.length < 8) return false;
  for (const num of allowedSet) {
    if (num.endsWith(senderSuffix)) return true;
    const numSuffix = num.slice(-10);
    if (numSuffix.length >= 8 && sender.endsWith(numSuffix)) return true;
  }
  return false;
}

/**
 * Fetches the full list of authorized numbers for a bot-central slug from the edge function.
 * Results are cached per slug for TTL_MS (60 s).
 *
 * Returns a Set<string> of digits-only phone numbers on success.
 * Returns null on any error (network, non-2xx, bad JSON) — caller must fall back.
 */
async function getAllowedCentralNumbers(slug) {
  const now = Date.now();
  const cached = _cache.get(slug);
  if (cached && cached.expiresAt > now) return cached.numeros;

  const baseUrl = process.env.SUPABASE_FUNCTIONS_URL || process.env.LOVABLE_EDGE_URL;
  const secret = process.env.RAILWAY_BOT_SECRET;

  try {
    const res = await fetch(
      `${baseUrl}/agente-central-numeros-permitidos?slug=${encodeURIComponent(slug)}`,
      { headers: { 'X-Bot-Secret': secret } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data.success || !Array.isArray(data.numeros)) {
      throw new Error('Respuesta inesperada: se esperaba { success: true, numeros: [...] }');
    }

    const numeros = new Set(
      data.numeros.map(n => String(n).replace(/\D/g, '')).filter(Boolean)
    );
    _cache.set(slug, { numeros, expiresAt: now + TTL_MS });
    console.log('[allowed-numbers] slug=', slug, 'count=', numeros.size);
    return numeros;
  } catch (err) {
    console.warn('[allowed-numbers] fallback for slug=', slug, err);
    return null;
  }
}

module.exports = { getAllowedCentralNumbers, normalizeJid, matchesAllowed };
