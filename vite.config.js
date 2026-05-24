// vite.config.js
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'public'), // or wherever your index.html is
  base: '/',
  publicDir: path.resolve(__dirname, 'public/assets'),
  build: {
    outDir: path.resolve(__dirname, 'dist'), // Output dir for production build
    emptyOutDir: true, // Empties output dir on each build
    rollupOptions: {
        input: {
            main: path.resolve(__dirname, 'public/index.html'),
        }
    },
  },
  server: {
    port: 8080, // Dev server port
    hmr: {
      overlay: true, // Show errors in browser overlay
    },
  },
  optimizeDeps: {
    include: [],
  },
});
