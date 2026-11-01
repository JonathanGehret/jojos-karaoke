<script lang="ts">
  import { drawQr } from '../lib/qr';
  let { text, size = 200 }: { text: string; size?: number } = $props();
  let c: HTMLCanvasElement;
  $effect(() => { drawQr(c, text, size); });
</script>

<canvas bind:this={c} class="qr" width={size} height={size} aria-label="QR code"></canvas>
