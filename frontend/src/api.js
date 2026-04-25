const API_URL = (process.env.REACT_APP_API_URL || '/api').replace(/\/$/, '');

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
  try {
    res = await fetch(url, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    });
  } catch (e) {
    const isNetwork = e && (e.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(e.message || '')));
    if (isNetwork) {
      const hint =
        (typeof window !== 'undefined' &&
          process.env.REACT_APP_API_URL == null &&
          !/\/localhost(?::\d+)?$/.test(window.location.host))
          ? ' Set REACT_APP_API_URL in your hosting build to your public API base URL, including /api (then redeploy the frontend).'
          : ' Check that the API is running and CORS is allowed for this site.';
      throw new Error(
        `Cannot reach the server (${url}).${hint} (${e.message || 'network'})`
      );
    }
    throw e;
  }
  const data = await res.json().catch(() => ({}));
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
    apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) }),
  login: (email, password) =>
    apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
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
