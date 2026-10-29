import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
if (process.platform !== "linux" || /^\/mnt\/[a-z](?:\/|$)/i.test(projectRoot))
  throw new Error(
    "请在 WSL2 的 ~/Project/MarkSix 开发；禁止 Windows 进程或 Windows 挂载盘。Linux CI 和容器可正常构建。",
  );

const { defineConfig } = await import("vite");
const { svelte } = await import("@sveltejs/vite-plugin-svelte");

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
