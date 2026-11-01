<script lang="ts">
  // "My songs": karaoke songs stored on this device.
  import { onDestroy } from 'svelte';
  import { mmss } from '../lib/format';
  import {
    type StoredSong, deleteSong, downloadBytes, exportJkp, fileName, importJkp, listSongs, onLibraryChange, storageInfo, toPackage,
  } from '../lib/localLibrary';
  import { navigate } from '../lib/nav.svelte';
  import { session } from '../lib/session';
  import { store } from '../lib/store';
  import { uploadSong } from '../lib/make/pipeline';

  let songs = $state<StoredSong[]>([]);
  let filter = $state('');
  let info = $state<{ used: number; quota: number; persisted: boolean } | null>(null);
  let msg = $state<string | null>(null);
  let busy = $state<string | null>(null);

  async function refresh() {
    songs = await listSongs();
    info = await storageInfo();
  }
  refresh();
  const off = onLibraryChange(refresh);
  onDestroy(() => off());

  const shown = $derived(songs.filter((s) => `${s.manifest.title} ${s.manifest.artist}`.toLowerCase().includes(filter.toLowerCase())));
  const mb = (b: number) => `${(b / 1e6).toFixed(b > 1e8 ? 0 : 1)} MB`;

  async function play(s: StoredSong) {
    session.localPackage = await toPackage(s);
    session.localSongId = s.id;
    navigate('/solo');
  }
  async function edit(s: StoredSong) {
    session.localPackage = await toPackage(s);
    session.localSongId = s.id;
    navigate('/edit');
  }
  async function download(s: StoredSong) { downloadBytes(await exportJkp(s), fileName(s.manifest)); }
  async function remove(s: StoredSong) {
    if (confirm(`Delete "${s.manifest.title}" from this device?`)) await deleteSong(s.id);
  }
  async function upload(s: StoredSong) {
    if (!store.ownerToken) return navigate('/settings');
    busy = s.id;
    try {
      const p = await toPackage(s);
      await uploadSong(store.ownerToken, { manifest: p.manifest, lyrics: p.lyrics, files: p.files, warnings: [], backend: '' });
      msg = `"${s.manifest.title}" is now in your online library.`;
    } catch (e) { msg = (e as Error).message; }
    finally { busy = null; }
  }
  async function importFiles(e: Event) {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    let ok = 0;
    for (const f of files) {
      try { await importJkp(new Uint8Array(await f.arrayBuffer())); ok++; }
      catch (err) { msg = `${f.name}: ${(err as Error).message}`; }
    }
    if (ok) msg = `Imported ${ok} song${ok === 1 ? '' : 's'}.`;
    (e.target as HTMLInputElement).value = '';
  }
</script>

<main class="page songs-page">
  <header class="bar"><button class="link" onclick={() => navigate('/')}>← Home</button><h2>My songs</h2>
    <button class="primary" onclick={() => navigate('/make')}>＋ Make</button></header>
  <p class="hint">Stored in this app on this device{#if info} · {songs.length} songs · {mb(info.used)} used{#if !info.persisted} · the browser may clear them if the device runs low on space, so keep downloads of songs you care about{/if}{/if}.</p>
  {#if msg}<p class="hint">{msg}</p>{/if}
  <div class="row">
    <input bind:value={filter} placeholder="Search" style="flex:1" />
    <label class="button-like">Import .jkp<input type="file" accept=".jkp,application/zip" multiple onchange={importFiles} hidden /></label>
  </div>
  <ul class="songs local">
    {#each shown as s (s.id)}
      <li>
        <span class="what"><b>{s.manifest.title}</b> <span class="muted">{s.manifest.artist} · {mmss(s.manifest.durationMs)} · {mb(s.size)}</span></span>
        <span class="acts">
          <button class="small" onclick={() => play(s)}>▶ Play</button>
          <button class="small" onclick={() => edit(s)}>Timing</button>
          <button class="small" onclick={() => download(s)}>Download</button>
          {#if store.ownerToken}<button class="small" onclick={() => upload(s)} disabled={busy === s.id}>{busy === s.id ? '…' : 'Upload'}</button>{/if}
          <button class="small danger" onclick={() => remove(s)}>✕</button>
        </span>
      </li>
    {:else}
      <li class="muted">{filter ? 'No match.' : 'No songs on this device yet. Make one, or import a .jkp file.'}</li>
    {/each}
  </ul>
</main>
