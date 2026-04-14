const api = {
  async list() {
    const r = await fetch('/api/facilities');
    return r.json();
  },
  async get(id) {
    const r = await fetch('/api/facilities/' + id);
    if (!r.ok) throw new Error('not found');
    return r.json();
  },
  async create(input) {
    const r = await fetch('/api/facilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'failed');
    return r.json();
  },
  async del(id) {
    await fetch('/api/facilities/' + id, { method: 'DELETE' });
  },
  async saveNotes(id, notes) {
    await fetch('/api/facilities/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
  },
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtMoney(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(0) + 'k';
  return '$' + n.toLocaleString();
}
function fmtPct(n) {
  if (n == null) return '—';
  return (n * (n <= 1 ? 100 : 1)).toFixed(1) + '%';
}
function fmtNum(n, d = 1) {
  if (n == null) return '—';
  return Number(n).toFixed(d);
}
function fmtRange(lo, hi, fmt = fmtMoney) {
  if (lo == null && hi == null) return '—';
  if (lo != null && hi != null && lo !== hi) return fmt(lo) + ' – ' + fmt(hi);
  return fmt(lo ?? hi);
}
