// Wake lock + fullscreen helpers (best effort; not every browser supports them).

let lock: WakeLockSentinel | null = null;

export async function keepAwake() {
  try {
    lock = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && (!lock || lock.released)) {
        try { lock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
      }
    });
  } catch { /* unsupported or denied */ }
}

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* ignore */ }
}

export function vibrate(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
}
