// Small typed wrappers around localStorage. Everything here lives on this device only.

function get<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function set(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage full or disabled */ }
}

export const store = {
  get ownerToken(): string | null { return get('jk.ownerToken', null); },
  set ownerToken(v: string | null) { set('jk.ownerToken', v); },
  get nickname(): string { return get('jk.nickname', ''); },
  set nickname(v: string) { set('jk.nickname', v); },
  /** Bluetooth/output latency correction for this device, ms (positive = lyrics later). */
  get deviceOffsetMs(): number { return get('jk.deviceOffsetMs', 0); },
  set deviceOffsetMs(v: number) { set('jk.deviceOffsetMs', Math.round(v)); },
  adminToken(code: string): string | null { return get<Record<string, string>>('jk.admin', {})[code] ?? null; },
  setAdminToken(code: string, token: string) {
    const all = get<Record<string, string>>('jk.admin', {});
    all[code] = token;
    set('jk.admin', all);
  },
  memberToken(code: string): string | null { return get<Record<string, string>>('jk.member', {})[code] ?? null; },
  setMemberToken(code: string, token: string | null) {
    const all = get<Record<string, string>>('jk.member', {});
    if (token) all[code] = token; else delete all[code];
    set('jk.member', all);
  },
  get recentRooms(): string[] { return get('jk.recentRooms', []); },
  addRecentRoom(code: string) { set('jk.recentRooms', [code, ...this.recentRooms.filter((c) => c !== code)].slice(0, 5)); },
  get vocal(): number { return get('jk.vocal', 0); },
  set vocal(v: number) { set('jk.vocal', v); },
};
