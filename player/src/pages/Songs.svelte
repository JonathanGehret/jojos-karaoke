<script lang="ts">
  // "My songs": karaoke songs stored on this device.
  import { onDestroy } from 'svelte';
  import { CloudUpload, Download, FileUp, Library, PencilLine, Play, Plus, Search, Trash2 } from '@lucide/svelte';
  import TopBar from '../components/TopBar.svelte';
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
  <TopBar title="My songs">
    <button class="primary" onclick={() => navigate('/make')}><Plus size={18} />Make</button>
  </TopBar>
  <p class="hint">Stored in this app on this device{info ? ` · ${songs.length} ${songs.length === 1 ? 'song' : 'songs'} · ${mb(info.used)} used` : ''}.{#if info && !info.persisted}
    The browser may clear them if the device runs low on space, so keep downloads of songs you care about.{/if}</p>
  {#if msg}<p class="hint" role="status">{msg}</p>{/if}
  <div class="row" style="margin:.6rem 0">
    <div class="search-box"><Search size={18} /><input type="search" bind:value={filter} placeholder="Search" aria-label="Search my songs" /></div>
    <label class="button-like"><FileUp size={18} />Import .jkp<input type="file" accept=".jkp,application/zip" multiple onchange={importFiles} hidden /></label>
  </div>
  <ul class="songs local">
    {#each shown as s (s.id)}
      <li>
        <span class="what"><b>{s.manifest.title}</b> <span class="muted">{s.manifest.artist}{s.manifest.artist ? ' · ' : ''}{mmss(s.manifest.durationMs)} · {mb(s.size)}</span></span>
        <span class="acts">
          <button class="small primary" onclick={() => play(s)}><Play size={15} />Play</button>
          <button class="small" onclick={() => edit(s)} title="Fix the timing"><PencilLine size={15} />Timing</button>
          <button class="small icon" onclick={() => download(s)} title="Download .jkp" aria-label="Download {s.manifest.title}"><Download size={16} /></button>
          {#if store.ownerToken}<button class="small icon" onclick={() => upload(s)} disabled={busy === s.id} title="Upload to my online library" aria-label="Upload {s.manifest.title}"><CloudUpload size={16} /></button>{/if}
          <button class="small icon danger" onclick={() => remove(s)} title="Delete" aria-label="Delete {s.manifest.title}"><Trash2 size={16} /></button>
        </span>
      </li>
    {:else}
      <li class="empty-state" style="border:none; background:none">
        {#if filter}<span>No match for “{filter}”.</span>
        {:else}<Library size={40} /><b>No songs on this device yet.</b><span>Make one from a song file you own, or import a .jkp package.</span>
          <button class="primary" onclick={() => navigate('/make')}><Plus size={18} />Make a song</button>{/if}
      </li>
    {/each}
  </ul>
</main>
