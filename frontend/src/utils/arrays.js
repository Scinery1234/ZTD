/**
 * Ensure a value is an array (API / legacy data may return objects or null).
 */
export function asArray(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === 'object') {
    if (x.length != null && typeof x.length === 'number' && !Array.isArray(x)) {
      return Array.from(x);
    }
    return Object.values(x);
  }
  return [];
}

/**
 * API task subtasks: must be an array of {id, text, done} for .map in UI.
 */
export function asSubtaskList(x) {
  const arr = asArray(x);
  return arr
    .map((s) => {
      if (s == null || typeof s !== 'object') return null;
      return {
        id: s.id,
        text: s.text != null ? String(s.text) : '',
        done: Boolean(s.done),
      };
    })
    .filter(Boolean);
}
