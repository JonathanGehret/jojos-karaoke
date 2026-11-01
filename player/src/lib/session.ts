// Hand-off between pages in the same tab (e.g. a local package from Solo to the Editor).
import type { LocalPackage } from './jkp';

export const session: { localPackage: LocalPackage | null } = { localPackage: null };
