import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = env.VITE_API_URL || "http://localhost:4000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Proxy: en dev el frontend llama /api/... y Vite lo reenvia al backend
      proxy: {
        "/api": { target: apiUrl, changeOrigin: true },
      },
    },
  };
});
