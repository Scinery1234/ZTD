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

/** AI turns run a Claude tool loop server-side and can legitimately take
 *  minutes — give /chat and /coach far more room than ordinary requests. */
const AI_TIMEOUT_MS = 180000;

function getToken() {
  return localStorage.getItem('mh_token') || sessionStorage.getItem('mh_token');
}

function clearToken() {
  localStorage.removeItem('mh_token');
  sessionStorage.removeItem('mh_token');
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
  const { skipAuth, timeoutMs, ...restOptions } = options;
  const fetchTimeout = timeoutMs || FETCH_TIMEOUT_MS;
  const baseHeaders = skipAuth
    ? { 'Content-Type': 'application/json' }
    : authHeaders();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), fetchTimeout);
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
          fetchTimeout / 1000
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
      clearToken();
      window.dispatchEvent(new Event('mh-session-expired'));
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
  forgotPassword: (email) =>
    apiFetch('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
      skipAuth: true,
    }),
  resetPassword: (token, password) =>
    apiFetch('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
      skipAuth: true,
    }),
  verifyEmail: (token) =>
    apiFetch(`/auth/verify-email?token=${encodeURIComponent(token)}`, { skipAuth: true }),
  resendVerification: () =>
    apiFetch('/auth/resend-verification', { method: 'POST' }),
  me: () => apiFetch('/auth/me'),

  // Hats
  getHats: () => apiFetch('/hats'),
  createHat: (data) => apiFetch('/hats', { method: 'POST', body: JSON.stringify(data) }),
  updateHat: (id, data) => apiFetch(`/hats/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteHat: (id) => apiFetch(`/hats/${id}`, { method: 'DELETE' }),
  reorderHats: (hat_ids) => apiFetch('/hats/reorder', { method: 'POST', body: JSON.stringify({ hat_ids }) }),

  // Tasks (hat_id is optional query param)
  getTasks: (hat_id) => apiFetch(hat_id != null ? `/tasks?hat_id=${hat_id}` : '/tasks'),
  getTasksForDate: (dateStr, hat_id) => {
    const base = `/tasks?view_date=${dateStr}`;
    return apiFetch(hat_id != null ? `${base}&hat_id=${hat_id}` : base);
  },
  getDoneTasks: (hat_id) => apiFetch(hat_id != null ? `/tasks/done?hat_id=${hat_id}` : '/tasks/done'),
  addTask: (data) => apiFetch('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id, data) => apiFetch(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTask: (id) => apiFetch(`/tasks/${id}`, { method: 'DELETE' }),
  markDone: (id) => apiFetch(`/tasks/${id}/done`, { method: 'POST' }),
  unmarkDone: (id) => apiFetch(`/tasks/done/${id}/restore`, { method: 'POST' }),
  reorder: (tasks) => apiFetch('/tasks/reorder', { method: 'POST', body: JSON.stringify({ tasks }) }),
  incrementPomodoro: (taskId) => apiFetch(`/tasks/${taskId}/pomodoro`, { method: 'POST' }),

  // Analytics (premium)
  getAnalytics: () => apiFetch('/analytics'),

  // Export (pro + premium) — triggers a file download
  exportData: async (format = 'json') => {
    const href = `/export?format=${format}`;
    const url = `${API_URL}${href}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = d.error || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `madehappen-export.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  },

  // Stripe / Tiers
  getTiers: () => apiFetch('/stripe/tiers'),
  getSubscription: () => apiFetch('/stripe/subscription'),
  createCheckoutSession: (tier) =>
    apiFetch('/stripe/create-checkout-session', { method: 'POST', body: JSON.stringify({ tier }) }),

  // Calendar sync (premium)
  calendarAuth: (provider) =>
    apiFetch(`/calendar/auth/${provider}`, { method: 'POST' }),
  calendarConnections: () => apiFetch('/calendar/connections'),
  calendarPush: (timezone, task_ids) =>
    apiFetch('/calendar/push', {
      method: 'POST',
      body: JSON.stringify({ timezone, ...(task_ids ? { task_ids } : {}) }),
    }),
  calendarDisconnect: (provider) =>
    apiFetch(`/calendar/disconnect/${provider}`, { method: 'DELETE' }),
  calendarDeleteEvent: (taskId) =>
    apiFetch(`/calendar/event/${taskId}`, { method: 'DELETE' }),

  // AI Chat (add / delete / bulk-modify tasks via natural language)
  chat: (message, hat_id, history) =>
    apiFetch('/chat', {
      method: 'POST',
      timeoutMs: AI_TIMEOUT_MS,
      body: JSON.stringify({ message, ...(hat_id != null ? { hat_id } : {}), history: history || [] }),
    }),
  chatUndo: (undo_token) =>
    apiFetch('/chat/undo', {
      method: 'POST',
      body: JSON.stringify(undo_token != null ? { undo_token } : {}),
    }),

  // AI Coaching Hub (CBT, action, executive-function, charge, clarity coaches)
  coach: (coach_id, message, hat_id, history) =>
    apiFetch('/coach', {
      method: 'POST',
      timeoutMs: AI_TIMEOUT_MS,
      body: JSON.stringify({
        coach_id,
        message,
        ...(hat_id != null ? { hat_id } : {}),
        history: history || [],
      }),
    }),

  // Timebox pool dismissals — synced across devices
  getDismissed: (date) => apiFetch(`/timebox/dismissed/${date}`),
  saveDismissed: (date, task_ids) =>
    apiFetch(`/timebox/dismissed/${date}`, {
      method: 'PUT',
      body: JSON.stringify({ task_ids }),
    }),

  // Saved chats — one auto-resumed thread per hub tool
  chatThreadGet: (toolId) => apiFetch(`/chat/thread/${encodeURIComponent(toolId)}`),
  chatThreadClear: (toolId) => apiFetch(`/chat/thread/${encodeURIComponent(toolId)}`, { method: 'DELETE' }),

  // Goals — the goal-setting framework (max 3 active per hat)
  getGoals: (all) => apiFetch(all ? '/goals?include=all' : '/goals'),
  createGoal: (data) => apiFetch('/goals', { method: 'POST', body: JSON.stringify(data) }),
  updateGoal: (id, data) => apiFetch(`/goals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  checkinGoal: (id, note) =>
    apiFetch(`/goals/${id}/checkin`, { method: 'POST', body: JSON.stringify({ note: note || '' }) }),
  deleteGoal: (id) => apiFetch(`/goals/${id}`, { method: 'DELETE' }),

  // AI memory — persistent notes the hub keeps between conversations
  coachMemoryList: () => apiFetch('/coach/memory'),
  coachMemoryDelete: (id) => apiFetch(`/coach/memory/${id}`, { method: 'DELETE' }),
  coachMemoryClear: () => apiFetch('/coach/memory', { method: 'DELETE' }),
};
