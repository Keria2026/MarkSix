import { mount } from "svelte";
import "./app.css";
const target = document.getElementById("app")!;
async function start() {
  try {
    const response = await fetch("/api/site", { credentials: "same-origin" });
    if (!response.ok) throw new Error("无法连接服务，请稍后刷新重试。");
    const site = await response.json();
    document.documentElement.dataset.mode = site.mode;
    const { default: App } =
      site.mode === "authority"
        ? await import("./Management.svelte")
        : await import("./App.svelte");
    mount(App, { target });
  } catch {
    target.textContent = "无法连接 MarkSix 服务，请稍后刷新重试。";
  }
}
void start();
