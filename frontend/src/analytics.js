// Lightweight product analytics — fire-and-forget, never throws, no UI impact.
const _API = (() => {
  try { return (process.env.REACT_APP_API_URL || '/api').trim().replace(/\/$/, ''); }
  catch { return '/api'; }
})();

function _token() {
  try { return localStorage.getItem('mh_token') || sessionStorage.getItem('mh_token') || ''; }
  catch { return ''; }
}

export function track(eventName, properties = {}) {
  try {
    const t = _token();
    fetch(`${_API}/events/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
      },
      body: JSON.stringify({ event: eventName, properties }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
