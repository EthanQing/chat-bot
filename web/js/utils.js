export const nowISO = () => new Date().toISOString();
export const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
export const estimateTokens = (text = '') => Math.ceil([...String(text)].reduce((sum, ch) => sum + (/[^\x00-\xff]/.test(ch) ? 1.2 : 0.25), 0));

export function structuredCloneSafe(value) {
  try { return structuredClone(value); } catch (_) { return JSON.parse(JSON.stringify(value)); }
}

export function tryParseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

export function formatMaybeJson(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch (_) { return value; }
}

export function formatTime(value) {
  try { return new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
}

export function safeFileName(name) {
  return String(name || 'session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'session';
}

export function dateSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
