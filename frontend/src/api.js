const API_URL = process.env.REACT_APP_API_URL || '/api';

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
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

async function apiFetchRaw(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  }
  return res;
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

  // Trash (Premium)
  getTrash: () => apiFetch('/tasks/trash'),
  restoreTask: (id) => apiFetch(`/tasks/${id}/restore`, { method: 'POST' }),
  permanentDelete: (id) => apiFetch(`/tasks/${id}/permanent`, { method: 'DELETE' }),

  // Key Tasks (Premium)
  toggleKeyTask: (id) => apiFetch(`/tasks/${id}/key-task`, { method: 'PUT' }),

  // Export (Premium)
  exportTasks: async (format = 'json', hat_id = null) => {
    const params = new URLSearchParams({ format });
    if (hat_id != null) params.set('hat_id', hat_id);
    const res = await apiFetchRaw(`/export?${params}`);
    return res.blob();
  },

  // Stripe / Tiers
  getTiers: () => apiFetch('/stripe/tiers'),
  getSubscription: () => apiFetch('/stripe/subscription'),
  createCheckoutSession: (tier) =>
    apiFetch('/stripe/create-checkout-session', { method: 'POST', body: JSON.stringify({ tier }) }),
};
