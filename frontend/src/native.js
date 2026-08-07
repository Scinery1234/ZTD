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
