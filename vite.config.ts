import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // The preview is served through a proxy host that Vite cannot know in
  // advance, so host checking is disabled for both the dev server and the
  // production preview. This is a local, offline, telemetry-free app.
  server: { host: '0.0.0.0', port: 5173, strictPort: false, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
