<script lang="ts">
  import type { Lyrics } from '$shared/lyrics';
  import { LyricsRenderer } from '../lib/lyrics/renderer';

  let { lyrics, clock, size = 'big' }: { lyrics: Lyrics | null; clock: () => number; size?: 'big' | 'phone' } = $props();
  let el: HTMLDivElement;
  let r: LyricsRenderer | null = null;

  $effect(() => {
    r = new LyricsRenderer(el, () => clock());
    r.start();
    (window as any).__jkClock = () => clock(); // read by the e2e sync test
    return () => r?.stop();
  });

  $effect(() => {
    r?.setLyrics(lyrics);
  });
</script>

<div class="lyrics-host {size}" bind:this={el}></div>
