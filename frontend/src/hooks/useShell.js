import { useState, useCallback, useEffect } from 'react';

/**
 * Which shell the app renders: the classic task-first layout, or the
 * conversation-first Console.
 *
 * This is an experiment, so it's a flag rather than a replacement — both
 * shells run against the same data and the same components, and you can flip
 * between them to compare. Set by:
 *
 *   ?shell=console   — switch on (and remember)
 *   ?shell=classic   — switch off (and remember)
 *
 * or the toggle in the header. The URL wins on load so a link can put someone
 * straight into either one.
 */
const KEY = 'mh_shell';
export const SHELLS = { CLASSIC: 'classic', CONSOLE: 'console' };

function readParam() {
  try {
    const v = new URLSearchParams(window.location.search).get('shell');
    return v === SHELLS.CONSOLE || v === SHELLS.CLASSIC ? v : null;
  } catch {
    return null;
  }
}

function readStored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === SHELLS.CONSOLE || v === SHELLS.CLASSIC ? v : null;
  } catch {
    return null;
  }
}

function persist(shell) {
  try { localStorage.setItem(KEY, shell); } catch { /* ignore */ }
}

export function useShell() {
  const [shell, setShell] = useState(() => {
    const fromUrl = readParam();
    if (fromUrl) {
      // A ?shell= link is a choice, not a one-off view — remember it, so
      // reloading or reopening the app doesn't bounce back.
      persist(fromUrl);
      return fromUrl;
    }
    return readStored() || SHELLS.CLASSIC;
  });

  const choose = useCallback((next) => {
    setShell(next);
    persist(next);
  }, []);

  const toggle = useCallback(() => {
    choose(shell === SHELLS.CONSOLE ? SHELLS.CLASSIC : SHELLS.CONSOLE);
  }, [shell, choose]);

  // Keep the two shells from rendering under one another's body styles: the
  // Console owns the viewport and locks page scroll, the classic shell doesn't.
  useEffect(() => {
    const cls = 'shell-console';
    document.body.classList.toggle(cls, shell === SHELLS.CONSOLE);
    return () => document.body.classList.remove(cls);
  }, [shell]);

  return {
    shell,
    isConsole: shell === SHELLS.CONSOLE,
    choose,
    toggle,
  };
}
