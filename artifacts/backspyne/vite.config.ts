import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    // Built outside public/ so Vercel does not treat it as a static output
    // directory; the Express function serves this directory at runtime.
    outDir: path.resolve(import.meta.dirname, '../../dist/web'),
    emptyOutDir: true,
    // esbuild >=0.28 no longer lowers destructuring down to the es2020 default
    // target. The console's audience expects modern browsers, so ask for one.
    target: 'es2022',
  },
});
