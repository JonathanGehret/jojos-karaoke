<script lang="ts">
  import { route } from './lib/nav.svelte';
  import Home from './pages/Home.svelte';
  import Guest from './pages/Guest.svelte';
  import Screen from './pages/Screen.svelte';
  import Solo from './pages/Solo.svelte';
  import Editor from './pages/Editor.svelte';
  import Settings from './pages/Settings.svelte';
  import Make from './pages/Make.svelte';
  import Songs from './pages/Songs.svelte';

  const m = $derived(route.path.match(/^\/(join|screen|edit)\/([A-Za-z0-9]{4})(?:\/([a-z0-9-]+))?\/?$/));
</script>

{#if m && m[1] === 'join'}
  {#key m[2]}<Guest code={m[2].toUpperCase()} />{/key}
{:else if m && m[1] === 'screen'}
  {#key m[2]}<Screen code={m[2].toUpperCase()} />{/key}
{:else if m && m[1] === 'edit' && m[3]}
  {#key route.path}<Editor code={m[2].toUpperCase()} songId={m[3]} />{/key}
{:else if route.path === '/edit'}
  <Editor />
{:else if route.path === '/solo'}
  <Solo />
{:else if route.path === '/songs'}
  <Songs />
{:else if route.path === '/make'}
  <Make />
{:else if route.path === '/settings'}
  <Settings />
{:else}
  <Home />
{/if}
