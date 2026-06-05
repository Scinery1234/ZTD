/** Offline / fallback when GET /api/stripe/tiers fails (CORS, wrong URL, etc.) */
export const DEFAULT_TIERS = {
  free: {
    name: 'Free',
    price: 0,
    max_tasks: 10,
    features: [
      'Up to 10 active tasks',
      'Basic categories & priorities',
      'Drag & drop reordering',
      '3 Loose Threads',
      '30-day completed history',
    ],
  },
  pro: {
    name: 'Pro',
    price: 9,
    max_tasks: null,
    features: [
      'Unlimited tasks',
      'Pomodoro focus timer',
      'Data export (CSV & JSON)',
      '10 Loose Threads',
      '90-day task history',
    ],
  },
  premium: {
    name: 'Premium',
    price: 19,
    max_tasks: null,
    features: [
      'Everything in Pro',
      'Task notes (rich text per task)',
      'Advanced analytics dashboard',
      'Unlimited Loose Threads',
      'Full archive — all history',
      'Priority support',
    ],
  },
};

export function mergeTiersFromApi(data) {
  if (!data || typeof data !== 'object') {
    return { free: { ...DEFAULT_TIERS.free }, pro: { ...DEFAULT_TIERS.pro }, premium: { ...DEFAULT_TIERS.premium } };
  }
  return {
    free: { ...DEFAULT_TIERS.free, ...data.free },
    pro: { ...DEFAULT_TIERS.pro, ...data.pro },
    premium: { ...DEFAULT_TIERS.premium, ...data.premium },
  };
}
