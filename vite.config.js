import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `base: './'` keeps asset URLs relative so the same build works on Firebase
// Hosting and when `dist/` is loaded as an unpacked Chrome extension.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@firebase/firestore')) return 'firestore';
          if (id.includes('node_modules/@firebase/ai')) return 'ai';
          if (id.includes('node_modules/@firebase') || id.includes('node_modules/firebase')) return 'firebase';
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        }
      }
    }
  }
});
