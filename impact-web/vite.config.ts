import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5273 },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
