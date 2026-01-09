import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4000,
    strictPort: true, // Évite que Vite change de port si le 4000 est pris
  }
})