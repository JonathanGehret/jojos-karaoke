<script lang="ts">
  // Request a song that isn't in the list: upload a file, it's made into karaoke during the party.
  // Used on guests' phones and on the host screen (same flow, same server messages).
  import { FileAudio, Send } from '@lucide/svelte';
  import LyricsFinder from './LyricsFinder.svelte';
  import { uploadForRequest } from '../lib/api';
  import { audioDuration, guessFromFilename, songInfo } from '../lib/audioTags';
  import type { RoomConnection } from '../lib/room.svelte';

  let {
    code, conn, workersOnline = false, compact = false, onsent, onerror,
  }: {
    code: string;
    conn: RoomConnection | null;
    workersOnline?: boolean;
    /** host screen: no heading and a shorter hint */
    compact?: boolean;
    onsent?: () => void;
    onerror?: (message: string) => void;
  } = $props();

  let reqFile = $state<File | null>(null);
  let reqTitle = $state('');
  let reqArtist = $state('');
  let reqLyrics = $state('');
  let reqDuration = $state(0);
  let reqBusy = $state(false);
  let reqFinder = $state<LyricsFinder | null>(null);
  let input = $state<HTMLInputElement | null>(null);

  async function request(e: Event) {
    e.preventDefault();
    if (!reqFile || !conn?.memberToken) return;
    if (reqFile.size > 60 * 1024 * 1024) return onerror?.('That file is too big (max 60 MB).');
    reqBusy = true;
    try {
      const { uploadId } = await uploadForRequest(code, conn.memberToken, reqFile);
      conn.send({ type: 'request.add', uploadId, title: reqTitle.trim() || reqFile.name.replace(/\.[^.]+$/, ''),
        artist: reqArtist.trim(), lyrics: reqLyrics.trim() || undefined });
      reqFile = null; reqTitle = ''; reqArtist = ''; reqLyrics = ''; reqDuration = 0; reqFinder?.reset();
      if (input) input.value = '';
      onsent?.();
    } catch (err) { onerror?.((err as Error).message); }
    finally { reqBusy = false; }
  }

  async function pickFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    reqFile = f;
    reqLyrics = ''; reqDuration = 0;
    reqFinder?.reset();
    if (!f) return;
    ({ title: reqTitle, artist: reqArtist } = guessFromFilename(f.name));
    const info = await songInfo(f);
    if (reqFile !== f) return;
    reqTitle = info.title; reqArtist = info.artist;
    const d = await audioDuration(f);
    if (reqFile !== f) return;
    reqDuration = d;
    reqFinder?.search(true);
  }
</script>

<form class="stack" onsubmit={request}>
  {#if !compact}
    <h3>Request a song</h3>
    <p class="hint" style="margin-top:0">Not in the list? Upload your own copy: it is turned into karaoke during the
      party, and you can download the karaoke version afterwards.</p>
  {/if}
  {#if !workersOnline}
    <p class="hint warn">No device is making songs right now. {#if compact}Turn on “Make requests on this device” below,
      or the request waits.{:else}Your request waits until the host turns on “Make requests on this device” or a friend
      helps from <b>Make a song</b>.{/if}</p>
  {/if}
  <label class="dropzone">
    <FileAudio size={28} />
    <span class="what">{#if reqFile}<b>{reqFile.name}</b><span class="hint">Tap to pick another</span>
      {:else}<b>Choose a song file</b><span class="hint">{compact ? 'One you own' : "From your phone's files"}</span>{/if}</span>
    <input bind:this={input} type="file" accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus" onchange={pickFile} required />
  </label>
  <input bind:value={reqTitle} placeholder="Title" aria-label="Title" maxlength="120" required />
  <input bind:value={reqArtist} placeholder="Artist" aria-label="Artist" maxlength="120" />
  <span class="field-label">Lyrics <span class="hint" style="margin:0; font-weight:400">optional: otherwise looked up or transcribed</span></span>
  <LyricsFinder bind:this={reqFinder} bind:value={reqLyrics} title={reqTitle} artist={reqArtist} duration={reqDuration} />
  <button class="primary big" type="submit" disabled={reqBusy || !reqFile}><Send size={20} />{reqBusy ? 'Uploading…' : 'Request song'}</button>
</form>
