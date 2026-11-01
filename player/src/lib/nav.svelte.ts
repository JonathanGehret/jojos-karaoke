// Minimal path router.

export const route = $state({ path: location.pathname, hash: location.hash });

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  route.path = location.pathname;
  route.hash = location.hash;
  window.scrollTo(0, 0);
}

addEventListener('popstate', () => {
  route.path = location.pathname;
  route.hash = location.hash;
});

/** Read and remove `#admin=...` so the token isn't left in the address bar. */
export function takeHashParam(name: string): string | null {
  const p = new URLSearchParams(location.hash.slice(1));
  const v = p.get(name);
  if (v) {
    p.delete(name);
    const rest = p.toString();
    history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  }
  return v;
}
