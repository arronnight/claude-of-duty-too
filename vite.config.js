import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
  // Three.js ships large ES modules; keep them un-mangled for readable profiling.
  optimizeDeps: { include: ['three'] },
});
