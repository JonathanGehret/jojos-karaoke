<script lang="ts">
  import { createRoom } from '../lib/api';
  import { navigate } from '../lib/nav.svelte';
  import { store } from '../lib/store';

  let code = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  const recent = store.recentRooms.filter((c) => store.adminToken(c));

  async function host() {
    if (!store.ownerToken) return navigate('/settings?setup=1');
    busy = true;
    error = null;
    try {
      const r = await createRoom(store.ownerToken);
      store.setAdminToken(r.code, r.adminToken);
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
  <h1>Jojo's <span>Karaoke</span></h1>
  <p class="lead">Sing together. Lyrics on every phone, one shared queue.</p>

  <form class="card join" onsubmit={join}>
    <label for="code">Join a party</label>
    <div class="row">
      <input id="code" bind:value={code} maxlength="4" autocomplete="off" autocapitalize="characters"
             placeholder="CODE" inputmode="text" />
      <button class="primary" type="submit">Join</button>
    </div>
  </form>

  <div class="card">
    <button class="primary big" onclick={host} disabled={busy}>{busy ? 'Starting…' : '🎤 Host a party'}</button>
    <p class="hint">Open this on the TV or laptop that plays the music. Guests scan the QR code.</p>
    {#if recent.length}
      <p class="hint">Resume: {#each recent as c}<button class="link" onclick={() => navigate(`/screen/${c}`)}>{c}</button> {/each}</p>
    {/if}
  </div>

  <div class="row center">
    <button onclick={() => navigate('/solo')}>Play a .jkp file</button>
    <button onclick={() => navigate('/settings')}>Library & settings</button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
</main>
