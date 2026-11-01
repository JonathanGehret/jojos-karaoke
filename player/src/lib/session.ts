// Hand-off between pages in the same tab (e.g. a local package from Solo to the Editor).
import type { LocalPackage } from './jkp';

/** localSongId: set when the package came from "My songs", so edits are saved back there. */
export const session: { localPackage: LocalPackage | null; localSongId: string | null } = { localPackage: null, localSongId: null };
