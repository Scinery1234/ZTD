/**
 * Native (iOS/iPadOS) integration for the Capacitor shell.
 *
 * The same React bundle runs on the web and inside the native WKWebView, so
 * everything here is optional and guarded: on the web `isNative()` is false and
 * every call becomes a no-op. Capacitor packages are resolved lazily so the web
 * build never has to bundle them.
 */

// Capacitor injects this global into the webview; absent on the web.
export function isNative() {
  return Boolean(
    typeof window !== 'undefined' &&
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform()
  );
}

export function nativePlatform() {
  try { return window.Capacitor?.getPlatform?.() || 'web'; } catch { return 'web'; }
}

// Plugins live on the injected global, so a missing plugin degrades to a no-op
// rather than throwing — a wrapper should never break the app it's wrapping.
function plugin(name) {
  try { return window.Capacitor?.Plugins?.[name] || null; } catch { return null; }
}

/** Light tap for confirmations (mark done, save). Silent on web. */
export function haptic(style = 'light') {
  if (!isNative()) return;
  const h = plugin('Haptics');
  try { h?.impact?.({ style: String(style).toUpperCase() }); } catch { /* non-fatal */ }
}

/** Success/warning notification feedback. */
export function hapticNotify(type = 'SUCCESS') {
  if (!isNative()) return;
  const h = plugin('Haptics');
  try { h?.notification?.({ type }); } catch { /* non-fatal */ }
}

// ── Reminders ────────────────────────────────────────────────────────────────
// Local notifications (not push): the device schedules and fires these itself,
// so reminders work with no server, no APNs certificate, and no network. This
// is also the app's answer to App Store guideline 4.2 — real device capability
// a web page cannot have.

const REMINDER_TAG = 40000;   // id offset so we only ever clear our own alarms

/** Ask once, the first time we actually have something to schedule. */
export async function ensureNotificationPermission() {
  if (!isNative()) return false;
  const ln = plugin('LocalNotifications');
  if (!ln) return false;
  try {
    const { display } = await ln.checkPermissions();
    if (display === 'granted') return true;
    if (display === 'denied') return false;          // respect a previous no
    const res = await ln.requestPermissions();
    return res.display === 'granted';
  } catch {
    return false;
  }
}

/** Local time for a task's reminder, or null when it isn't schedulable. */
function reminderAt(task, leadMinutes) {
  const day = task.scheduled_date || task.due;
  if (!day) return null;
  // A timed task fires `leadMinutes` before it starts; an all-day task with only
  // a due date nudges that morning instead of at midnight.
  const time = task.scheduled_time || '09:00';
  const at = new Date(`${day}T${time}:00`);
  if (Number.isNaN(at.getTime())) return null;
  if (task.scheduled_time) at.setMinutes(at.getMinutes() - leadMinutes);
  return at > new Date() ? at : null;
}

/**
 * Rebuild the reminder schedule from the current task list.
 *
 * Cheap to call on every task change: we cancel the alarms we own and re-add
 * them, so the schedule always matches what the user is actually carrying.
 */
export async function syncReminders(tasks, { leadMinutes = 10, max = 32 } = {}) {
  if (!isNative()) return 0;
  const ln = plugin('LocalNotifications');
  if (!ln) return 0;
  if (!(await ensureNotificationPermission())) return 0;

  try {
    const pending = await ln.getPending();
    const ours = (pending?.notifications || []).filter(n => n.id >= REMINDER_TAG);
    if (ours.length) await ln.cancel({ notifications: ours.map(n => ({ id: n.id })) });

    const due = (tasks || [])
      .map(t => ({ task: t, at: reminderAt(t, leadMinutes) }))
      .filter(x => x.at)
      .sort((a, b) => a.at - b.at)
      .slice(0, max);          // iOS caps pending local notifications at 64

    if (!due.length) return 0;
    await ln.schedule({
      notifications: due.map(({ task, at }, i) => ({
        id: REMINDER_TAG + i,
        title: task.scheduled_time ? 'Starting soon' : 'Due today',
        body: task.description,
        schedule: { at },
        extra: { taskId: task.id },
      })),
    });
    return due.length;
  } catch {
    return 0;                  // reminders are a bonus; never break the app
  }
}

/** True when the device is offline (used to serve the cached task list). */
export function isOffline() {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * One-time shell setup: match the status bar to the app's dark chrome, hide the
 * splash once React has painted, and let the keyboard resize the viewport.
 */
export function initNativeShell() {
  if (!isNative()) return;

  const statusBar = plugin('StatusBar');
  try {
    statusBar?.setStyle?.({ style: 'DARK' });     // light glyphs on dark chrome
    statusBar?.setOverlaysWebView?.({ overlay: false });
  } catch { /* non-fatal */ }

  try { plugin('SplashScreen')?.hide?.(); } catch { /* non-fatal */ }

  // Mark the document so CSS can add safe-area padding only in the native shell.
  try {
    document.documentElement.classList.add('is-native', `is-${nativePlatform()}`);
  } catch { /* non-fatal */ }

  // iOS has no hardware back button, but iPadOS keyboards and Android do —
  // exit gracefully instead of dead-ending on the first screen.
  const app = plugin('App');
  try {
    app?.addListener?.('backButton', ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else app?.exitApp?.();
    });
  } catch { /* non-fatal */ }
}
