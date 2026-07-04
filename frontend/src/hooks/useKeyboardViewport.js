import { useEffect } from 'react';

/**
 * Keep chat layouts sized to the *visible* viewport on mobile.
 *
 * iOS Safari doesn't shrink the page layout when the software keyboard opens —
 * it scroll-jumps the document instead, which shoves a fixed-height chat
 * around and hides the latest messages. This hook tracks window.visualViewport
 * into CSS custom properties on <html>:
 *
 *   --vvh  visible viewport height (px)
 *   --vvt  visible viewport top offset (px)
 *
 * and pins the document scroll back to 0, so containers styled with
 * `height: var(--vvh, 100dvh)` shrink to the space above the keyboard —
 * composer directly above the keys, messages still readable.
 */
export function useKeyboardViewport(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const root = document.documentElement;
    let raf = null;

    const apply = () => {
      raf = null;
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
      // Undo Safari's automatic document scroll — our layout now fits the
      // visible area, so any residual scroll just hides the header.
      if (window.scrollY > 0) window.scrollTo(0, 0);
    };
    const onChange = () => {
      if (raf === null) raf = requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener('resize', onChange);
    vv.addEventListener('scroll', onChange);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      vv.removeEventListener('resize', onChange);
      vv.removeEventListener('scroll', onChange);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvt');
    };
  }, [enabled]);
}
