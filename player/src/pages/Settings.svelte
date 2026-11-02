<script lang="ts">
  import TopBar from '../components/TopBar.svelte';
  import type { SongSummary } from '$shared/protocol';
  import * as api from '../lib/api';
  import { audioContext, unlockAudio } from '../lib/audio/engine';
  import { mmss } from '../lib/format';
  import { navigate } from '../lib/nav.svelte';
  import { store } from '../lib/store';

  const setup = new URLSearchParams(location.search).has('setup');
  let token = $state(store.ownerToken);
  let who = $state<{ name: string; role: string } | null>(null);
  let name = $state('');
  let signupCode = $state('');
  let pasted = $state('');
  let songs = $state<SongSummary[]>([]);
  let tokens = $state<{ id: string; name: string; role: string }[]>([]);
  let newFriend = $state('');
  let friendToken = $state<string | null>(null);
  let error = $state<string | null>(null);
  let filter = $state('');
  let offset = $state(store.deviceOffsetMs);
  let calibrating = $state(false);
  let taps: number[] = [];

  async function refresh() {
    if (!token) return;
    try {
      who = await api.me(token);
      songs = (await api.librarySongs(token)).songs;
      tokens = who.role === 'owner' ? (await api.listTokens(token)).tokens : [];
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => { refresh(); });

  async function create(e: Event) {
    e.preventDefault();
    error = null;
    try {
      const r = await api.signUp(name.trim(), signupCode.trim() || undefined);
      store.ownerToken = token = r.token;
      await refresh();
      if (setup) navigate('/');
    } catch (err) { error = (err as Error).message; }
  }

  async function usePasted(e: Event) {
    e.preventDefault();
    error = null;
    try {
      await api.me(pasted.trim());
      store.ownerToken = token = pasted.trim();
      pasted = '';
      await refresh();
    } catch (err) { error = (err as Error).message; }
  }

  function signOut() {
    store.ownerToken = token = null;
    who = null; songs = []; tokens = [];
  }

  async function addFriend(e: Event) {
    e.preventDefault();
    if (!token) return;
    friendToken = (await api.createToken(token, newFriend.trim() || 'friend')).token;
    newFriend = '';
    await refresh();
  }

  async function revoke(id: string) {
    if (!token || !confirm('Revoke this token? That maker can no longer add songs.')) return;
    await api.revokeToken(token, id);
    await refresh();
  }

  async function del(s: SongSummary) {
    if (!token || !confirm(`Delete "${s.title}" from the library?`)) return;
    await api.deleteSong(token, s.id);
    await refresh();
  }

  const copy = (t: string) => navigator.clipboard?.writeText(t);
  const loginCmd = (t: string) => `jojo login --server ${location.origin} --token ${t}`;

  // Latency calibration: a click every 750 ms; tap along; the median lag is the offset.
  async function calibrate() {
    await unlockAudio();
    const ctx = audioContext();
    calibrating = true;
    taps = [];
    const t0 = ctx.currentTime + 0.5;
    const beats: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t = t0 + i * 0.75;
      beats.push(t);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i % 4 ? 880 : 1320;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.6, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.1);
    }
    const tap = () => taps.push(ctx.currentTime);
    addEventListener('pointerdown', tap);
    addEventListener('keydown', tap);
    setTimeout(() => {
      removeEventListener('pointerdown', tap);
      removeEventListener('keydown', tap);
      calibrating = false;
      const lags = taps.map((t) => {
        const b = beats.reduce((a, x) => (Math.abs(x - t) < Math.abs(a - t) ? x : a), beats[0]);
        return (t - b) * 1000;
      }).filter((l) => Math.abs(l) < 375).sort((a, b) => a - b);
      if (lags.length < 4) { error = 'Not enough taps; try again.'; return; }
      offset = Math.round(lags[lags.length >> 1]);
      store.deviceOffsetMs = offset;
    }, (0.5 + 12 * 0.75 + 0.5) * 1000);
  }
</script>

<main class="page">
  <TopBar title="Settings & library" />

  {#if error}<p class="error">{error}</p>{/if}

  {#if !token}
    <section class="card">
      <h3>Create your library</h3>
      <p class="hint">Your songs live in a private online library. Only you, makers you invite, and the guests of your parties can use them.</p>
      <form onsubmit={create} class="stack">
        <input bind:value={name} placeholder="Your name" required maxlength="40" />
        <input bind:value={signupCode} placeholder="Signup code (if the server needs one)" />
        <button class="primary" type="submit">Create library</button>
      </form>
    </section>
    <section class="card">
      <h3>Already have a library or a friend's token?</h3>
      <form onsubmit={usePasted} class="stack">
        <input bind:value={pasted} placeholder="Paste your token (owner or friend)" autocomplete="off" />
        <button type="submit">Use this token</button>
      </form>
    </section>
  {:else}
    <section class="card">
      <h3>{who?.name ?? '…'}'s library <span class="muted">({who?.role})</span></h3>
      <p class="hint">Connect the maker on your computer:</p>
      <code class="cmd">{loginCmd('••••')}</code>
      <div class="row"><button onclick={() => copy(loginCmd(token!))}>Copy login command</button>
        <button class="link danger" onclick={signOut}>Sign out on this device</button></div>
    </section>

    {#if who?.role === 'owner'}
      <section class="card">
        <h3>Friends who make songs</h3>
        <p class="hint">Give a friend their own token so their computer can add songs to your library and process requests at parties.</p>
        <form onsubmit={addFriend} class="row">
          <input bind:value={newFriend} placeholder="Friend's name" maxlength="40" />
          <button type="submit">Create token</button>
        </form>
        {#if friendToken}
          <p class="hint">Send this to your friend (shown once):</p>
          <code class="cmd">{loginCmd(friendToken)}</code>
          <button onclick={() => copy(loginCmd(friendToken!))}>Copy</button>
        {/if}
        <ul class="plain">
          {#each tokens.filter((t) => t.role === 'contributor') as t (t.id)}
            <li>{t.name} <button class="link danger" onclick={() => revoke(t.id)}>revoke</button></li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="card">
      <h3>Songs ({songs.length})</h3>
      {#if !songs.length}
        <p class="hint">No songs yet. <button class="link" onclick={() => navigate('/make')}>Make one in the browser</button>
          or on your computer: <code>jojo make song.mp3 --upload</code></p>
      {:else}
        <input bind:value={filter} placeholder="Search" />
        <ul class="songs">
          {#each songs.filter((s) => (s.title + ' ' + s.artist).toLowerCase().includes(filter.toLowerCase())) as s (s.id)}
            <li><span><b>{s.title}</b> <span class="muted">{s.artist} · {mmss(s.durationMs)}</span></span>
              {#if who?.role === 'owner'}<button class="link danger" onclick={() => del(s)}>delete</button>{/if}</li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <section class="card">
    <h3>Speaker delay on this device</h3>
    <p class="hint">Bluetooth speakers play late. Tap along with the clicks and the lyrics will be shifted to match. Current: <b>{offset} ms</b></p>
    <div class="row">
      <button onclick={calibrate} disabled={calibrating}>{calibrating ? 'Tap on every click…' : 'Calibrate'}</button>
      <input type="number" step="10" bind:value={offset} onchange={() => (store.deviceOffsetMs = offset)} style="width:7em" /> ms
    </div>
  </section>
</main>
