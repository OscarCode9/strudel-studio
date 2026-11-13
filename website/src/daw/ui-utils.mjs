export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function formatDb(gain) {
  if (!Number.isFinite(gain) || gain <= 0.001) return '-∞';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}
