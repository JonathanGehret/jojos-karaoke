import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  resolve: {
    alias: { $shared: fileURLToPath(new URL('../shared', import.meta.url)) },
    // ONNX Runtime: load its .wasm from /api/runtime (R2) instead of bundling 25+ MB files
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  worker: { format: 'es' },
  server: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' },
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } },
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      // App shell only. Songs stream from the online library and are never cached here.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // the browser maker (ONNX Runtime + transformers.js) loads on demand, not for every guest
        globIgnores: ['**/make.worker-*.js', '**/transformers*.js', '**/ort*.js'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
      manifest: {
        name: "Jojo's Karaoke",
        short_name: 'Karaoke',
        description: 'Sing together: synced lyrics on every phone, shared queue, QR join.',
        theme_color: '#14112b',
        background_color: '#14112b',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
