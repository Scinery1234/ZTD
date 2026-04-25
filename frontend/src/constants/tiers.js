/** Offline / fallback when GET /api/stripe/tiers fails (CORS, wrong URL, etc.) */
export const DEFAULT_TIERS = {
  free: {
    name: 'Free',
    price: 0,
    max_tasks: 10,
    features: [
      'Up to 10 active tasks',
      'All categories & priorities',
      'Drag & drop reordering',
    ],
  },
  pro: {
    name: 'Pro',
    price: 9,
    max_tasks: null,
    features: [
      'Unlimited tasks',
      'All Free features',
      'Recurring tasks',
      'Email reminders',
    ],
  },
  premium: {
    name: 'Premium',
    price: 19,
    max_tasks: null,
    features: [
      'Everything in Pro',
      'Priority support',
      'Advanced analytics',
      'Team sharing (coming soon)',
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
