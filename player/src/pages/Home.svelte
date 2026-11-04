<script lang="ts">
  import { FileMusic, Library, MicVocal, Play, Settings, Sparkles } from '@lucide/svelte';
  import { createRoom } from '../lib/api';
  import { navigate } from '../lib/nav.svelte';
  import { store } from '../lib/store';

  let code = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  const recent = store.recentRooms.filter((c) => store.adminToken(c));

  async function host() {
    busy = true;
    error = null;
    try {
      let r;
      try {
        r = await createRoom(store.ownerToken, store.nickname || undefined, store.signupCode || undefined);
      } catch (e) {
        if ((e as { status?: number }).status !== 403) throw e;
        const code = prompt(store.signupCode ? 'That signup code no longer works. Enter the new one:'
          : 'This server needs a signup code to host a party (ask whoever runs it):')?.trim();
        if (!code) return;
        r = await createRoom(store.ownerToken, store.nickname || undefined, code);
        store.signupCode = code; // remembered on this device: no need to type it again
      }
      store.setAdminToken(r.code, r.adminToken);
      store.setWorkerKey(r.code, r.workerKey);
      store.addRecentRoom(r.code);
      navigate(`/screen/${r.code}`);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function join(e: Event) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(c)) navigate(`/join/${c}`);
    else error = 'Room codes have 4 letters or digits.';
  }
</script>

<main class="home">
  <div class="logo" aria-hidden="true"><MicVocal size={38} strokeWidth={2.2} /></div>
  <h1>Jojo's <span>Karaoke</span></h1>
  <p class="lead">Sing together. Lyrics on every phone, one shared queue.</p>

  <form class="card join" onsubmit={join}>
    <label for="code">Join a party</label>
    <div class="row">
      <input id="code" bind:value={code} maxlength="4" autocomplete="off" autocapitalize="characters"
             placeholder="CODE" inputmode="text" aria-describedby={error ? 'home-error' : undefined} />
      <button class="primary" type="submit">Join</button>
    </div>
  </form>

  <div class="card host">
    <button class="primary big" onclick={host} disabled={busy}><MicVocal size={22} />{busy ? 'Starting…' : 'Host a party'}</button>
    <p class="hint">Open this on the TV or laptop that plays the music. Guests scan the QR code; your songs are
      offered to them. No account needed.</p>
    {#if recent.length}
      <div class="resume"><span class="hint">Resume:</span>
        {#each recent as c}<button class="small" onclick={() => navigate(`/screen/${c}`)}><Play size={14} /><span class="code">{c}</span></button>{/each}</div>
    {/if}
  </div>
  {#if error}<p class="error" id="home-error" role="alert">{error}</p>{/if}

  <nav class="tiles" aria-label="More">
    <button class="tile" onclick={() => navigate('/songs')}><Library size={24} /><b>My songs</b><span>Play, fix and share</span></button>
    <button class="tile" onclick={() => navigate('/make')}><Sparkles size={24} /><b>Make a song</b><span>From a file you own</span></button>
    <button class="tile" onclick={() => navigate('/solo')}><FileMusic size={24} /><b>Open a file</b><span>Play a .jkp package</span></button>
    <button class="tile" onclick={() => navigate('/settings')}><Settings size={24} /><b>Settings</b><span>Speaker delay, online library</span></button>
  </nav>
</main>
