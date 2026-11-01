import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  resolve: { alias: { $shared: fileURLToPath(new URL('../shared', import.meta.url)) } },
  server: {
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
