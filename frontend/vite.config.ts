import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      "/api": {
        target: process.env.API_TARGET ?? "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
  build: { target: "es2022" },
});
