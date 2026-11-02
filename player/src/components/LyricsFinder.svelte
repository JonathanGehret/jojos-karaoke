<script lang="ts">
  // Find lyrics online (LRCLIB via our server) and pick the right version, or paste your own.
  // `value` ends up as plain text or LRC, exactly what the maker accepts.
  import { CircleCheck, ClipboardPaste, LoaderCircle, Search, X } from '@lucide/svelte';
  import { DURATION_TOLERANCE_S, type LyricsCandidate } from '$shared/lyricsSearch';
  import { api } from '../lib/api';
  import { mmss } from '../lib/format';

  let {
    title = '', artist = '', duration = 0, value = $bindable(''), disabled = false,
    placeholder = 'Paste lyrics (plain text or .lrc)',
  }: { title?: string; artist?: string; duration?: number; value?: string; disabled?: boolean; placeholder?: string } = $props();

  let results = $state<LyricsCandidate[] | null>(null);
  let searching = $state(false);
  let error = $state<string | null>(null);
  let chosen = $state<LyricsCandidate | null>(null);
  let pasting = $state(false);
  let query = $state('');
  let editedQuery = $state(false);
  let seq = 0;

  const defaultQuery = $derived([artist, title].map((s) => s.trim()).filter(Boolean).join(' – '));
  $effect(() => { if (!editedQuery) query = defaultQuery; });

  const fits = (c: LyricsCandidate) => !duration || !c.duration || Math.abs(c.duration - duration) <= DURATION_TOLERANCE_S;
  const peek = (c: LyricsCandidate) => (c.plain ?? c.synced ?? '').replace(/^\[[^\]]*\]\s*/gm, '').replace(/<[^>]*>/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5).join('\n');

  /** Search; with `auto`, take a confident match without asking (only if nothing is filled in yet). */
  export async function search(auto = false) {
    const q = query.trim();
    if (!q && !title.trim()) return;
    const my = ++seq;
    searching = true; error = null;
    try {
      const params = new URLSearchParams();
      if (editedQuery || !title.trim()) params.set('q', q);
      else { params.set('title', title.trim()); if (artist.trim()) params.set('artist', artist.trim()); }
      if (duration) params.set('duration', String(Math.round(duration)));
      const r = await api<{ results: LyricsCandidate[] }>(`/api/lyrics/search?${params}`, { timeout: 25000 });
      if (my !== seq) return;
      results = r.results;
      const top = r.results[0];
      if (auto && top && !top.weak && fits(top) && !value.trim()) choose(top);
    } catch (e) {
      if (my === seq) { error = (e as { status?: number }).status === 429 ? 'Too many searches: wait a minute.' : (e as Error).message; results = null; }
    } finally {
      if (my === seq) searching = false;
    }
  }

  /** The text of the online result in use, if any (to tell it apart from pasted lyrics). */
  export function chosenText(): string | null {
    return chosen ? (chosen.synced ?? chosen.plain) : null;
  }

  /** Forget results (a different song was picked). */
  export function reset() {
    seq++; results = null; chosen = null; error = null; searching = false; editedQuery = false;
  }

  function choose(c: LyricsCandidate) {
    chosen = c;
    value = c.synced ?? c.plain ?? '';
    pasting = false;
  }

  function clear() {
    chosen = null;
    value = '';
  }

  function onsubmit(e: Event) {
    e.preventDefault();
    search();
  }
</script>

<div class="finder stack">
  {#if chosen}
    <div class="chosen-note">
      <CircleCheck size={18} />
      <span>Using <b>{chosen.title}</b> by {chosen.artist}
        <span class="badge {chosen.synced ? 'proc' : ''}">{chosen.synced ? 'synced' : 'text only'}</span></span>
      <span class="spacer"></span>
      <button type="button" class="small" onclick={() => (pasting = !pasting)} {disabled}>{pasting ? 'Hide text' : 'Edit text'}</button>
      <button type="button" class="small icon" aria-label="Don't use these lyrics" onclick={clear} {disabled}><X size={16} /></button>
    </div>
    {#if !pasting}<p class="peek">{peek(chosen)}</p>{/if}
  {/if}

  <!-- a div, not a form: this sits inside other forms -->
  <div class="row" role="search">
    <div class="search-box">
      <Search size={18} />
      <input type="search" bind:value={query} oninput={() => (editedQuery = true)} placeholder="Song and artist"
        aria-label="Search lyrics" {disabled} onkeydown={(e) => e.key === 'Enter' && onsubmit(e)} />
    </div>
    <button type="button" onclick={onsubmit} disabled={disabled || searching || !query.trim()}>
      {#if searching}<LoaderCircle size={18} class="spin" />{:else}<Search size={18} />{/if}Find lyrics</button>
  </div>
  {#if error}<p class="hint error">{error}</p>{/if}

  {#if results}
    {#if results.length}
      <ul class="results" aria-label="Lyrics found">
        {#each results as c (c.id + c.title)}
          <li><button type="button" class:chosen={chosen?.id === c.id} onclick={() => choose(c)} {disabled}>
            <span class="what"><b>{c.title}</b><span>{c.artist}{c.album ? ` · ${c.album}` : ''}</span></span>
            <span class="meta">
              <span class="badge {c.synced ? 'proc' : ''}">{c.synced ? 'synced' : 'text only'}</span>
              {#if c.duration}<span class:warn={!fits(c)} title={fits(c) ? 'Same length as your file' : 'Different length: maybe another version'}>{mmss(c.duration * 1000)}</span>{/if}
            </span>
          </button></li>
        {/each}
      </ul>
      <p class="hint">Synced lyrics give the best timing. Pick the one whose length matches your file.</p>
    {:else}
      <p class="hint">Nothing found. Try another spelling, or paste the lyrics.</p>
    {/if}
  {/if}

  {#if pasting || !chosen}
    {#if pasting || value}
      <textarea bind:value rows="6" {placeholder} {disabled} aria-label="Lyrics text"></textarea>
    {:else}
      <button type="button" class="link" onclick={() => (pasting = true)} {disabled}><ClipboardPaste size={16} />Paste lyrics yourself</button>
    {/if}
  {/if}
</div>

<style>
  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .finder .link { align-self: flex-start; }
</style>
