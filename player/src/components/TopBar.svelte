<script lang="ts">
  // Page header: back button, title, optional actions on the right.
  import type { Snippet } from 'svelte';
  import { ArrowLeft } from '@lucide/svelte';
  import { navigate } from '../lib/nav.svelte';

  let { title, back = '/', onback, children }: { title: string; back?: string; onback?: () => void; children?: Snippet } = $props();
</script>

<header class="bar">
  <button class="icon ghost" aria-label="Back" onclick={() => (onback ? onback() : navigate(back))}><ArrowLeft size={22} /></button>
  <h2>{title}</h2>
  {@render children?.()}
</header>
