function normalizeApiBase(raw) {
  const value = (raw || '/api').trim();
  if (value === '/api') return value;
  if (/^https?:\/\//i.test(value)) return value.replace(/\/$/, '');
  if (value.startsWith('//')) {
    const protocol = typeof window !== 'undefined' ? window.location.protocol : 'https:';
    return `${protocol}${value}`.replace(/\/$/, '');
  }
  // Common Railway misconfig: "my-api.up.railway.app/api" (missing protocol)
  if (/^[\w.-]+(?::\d+)?(\/.*)?$/.test(value) && !value.startsWith('/')) {
    const prefixed = value.startsWith('localhost') || value.startsWith('127.0.0.1')
      ? `http://${value}`
      : `https://${value}`;
    return prefixed.replace(/\/$/, '');
  }
  return value.replace(/\/$/, '');
}

const API_URL = normalizeApiBase(process.env.REACT_APP_API_URL || '/api');
const IS_RAILWAY_HOST =
  typeof window !== 'undefined' && /\.up\.railway\.app$/i.test(window.location.hostname);

function railwayApiHint() {
  if (!IS_RAILWAY_HOST) return '';
  return (
    ' Railway fix: set REACT_APP_API_URL to your backend service public domain with /api ' +
    '(example: https://your-backend.up.railway.app/api), then redeploy the frontend.'
  );
}

/** Avoid infinite loading if the API never responds (wrong URL, CORS hang, etc.) */
const FETCH_TIMEOUT_MS = 30000;

function getToken() {
  return localStorage.getItem('ztd_token');
}

function authHeaders() {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function apiFetch(path, options = {}) {
  const href = path.startsWith('/') ? path : `/${path}`;
  const url = `${API_URL}${href}`;

  let res;
  const { skipAuth, ...restOptions } = options;
  const baseHeaders = skipAuth
    ? { 'Content-Type': 'application/json' }
    : authHeaders();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    res = await fetch(url, {
      ...restOptions,
      signal: restOptions.signal || controller.signal,
      headers: { ...baseHeaders, ...(restOptions.headers || {}) },
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.message === 'The user aborted a request.')) {
      throw new Error(
        `The server did not answer in time (${Math.round(
          FETCH_TIMEOUT_MS / 1000
        )}s). Check that the API is reachable, CORS allows this site, and REACT_APP_API_URL is correct.`
      );
    }
    const isNetwork = e && (e.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(e.message || '')));
    if (isNetwork) {
      const hint =
        (typeof window !== 'undefined' &&
          process.env.REACT_APP_API_URL == null &&
          !/\/localhost(?::\d+)?$/.test(window.location.host))
          ? ` Set REACT_APP_API_URL in your hosting build to your public API base URL, including /api (then redeploy the frontend).${railwayApiHint()}`
          : ' Check that the API is running and CORS is allowed for this site.';
      throw new Error(
        `Cannot reach the server (${url}).${hint} (${e.message || 'network'})`
      );
    }
    throw e;
  } finally {
    window.clearTimeout(timeoutId);
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
  }

  // If we got HTML here, request likely hit the frontend service (or SPA fallback) not the API.
  if (contentType.includes('text/html')) {
    const isAuthPath = href.startsWith('/auth/');
    const prefix = isAuthPath
      ? 'Authentication request reached non-API endpoint.'
      : 'API request reached non-API endpoint.';
    throw Object.assign(
      new Error(
        `${prefix} Expected JSON but received HTML from ${url}. ` +
        'This usually means REACT_APP_API_URL points to the frontend URL (or missing /api), ' +
        `or your host rewrote /api/* to index.html.${railwayApiHint()}`
      ),
      { status: res.status, data: { raw: raw.slice(0, 200) } }
    );
  }
  if (!res.ok) {
    if (res.status === 401 && data.token_expired) {
      // Token expired mid-session — signal AuthContext to log out
      localStorage.removeItem('ztd_token');
      window.dispatchEvent(new Event('ztd-session-expired'));
    }
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  }
  return data;
}

export const api = {
  // Auth
  register: (name, email, password) =>
    apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      skipAuth: true,
    }),
  login: (email, password) =>
    apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipAuth: true,
    }),
  me: () => apiFetch('/auth/me'),

  // Hats
  getHats: () => apiFetch('/hats'),
  createHat: (data) => apiFetch('/hats', { method: 'POST', body: JSON.stringify(data) }),
  updateHat: (id, data) => apiFetch(`/hats/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteHat: (id) => apiFetch(`/hats/${id}`, { method: 'DELETE' }),
  reorderHats: (hat_ids) => apiFetch('/hats/reorder', { method: 'POST', body: JSON.stringify({ hat_ids }) }),

  // Tasks (hat_id is optional query param)
  getTasks: (hat_id) => apiFetch(hat_id != null ? `/tasks?hat_id=${hat_id}` : '/tasks'),
  getDoneTasks: (hat_id) => apiFetch(hat_id != null ? `/tasks/done?hat_id=${hat_id}` : '/tasks/done'),
  addTask: (data) => apiFetch('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id, data) => apiFetch(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTask: (id) => apiFetch(`/tasks/${id}`, { method: 'DELETE' }),
  markDone: (id) => apiFetch(`/tasks/${id}/done`, { method: 'POST' }),
  reorder: (tasks) => apiFetch('/tasks/reorder', { method: 'POST', body: JSON.stringify({ tasks }) }),

  // Stripe / Tiers
  getTiers: () => apiFetch('/stripe/tiers'),
  getSubscription: () => apiFetch('/stripe/subscription'),
  createCheckoutSession: (tier) =>
    apiFetch('/stripe/create-checkout-session', { method: 'POST', body: JSON.stringify({ tier }) }),
};
