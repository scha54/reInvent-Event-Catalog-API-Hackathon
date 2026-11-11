import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser bundle only holds the public API base URL (VITE_API_BASE_URL).
// No credentials or secrets are read or embedded by the frontend.
export default defineConfig({
  plugins: [react()],
});
