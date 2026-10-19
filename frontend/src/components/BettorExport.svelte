<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import fontUrl from "../assets/NotoSansSC-Regular.ttf?url";
  import { Download, LoaderCircle } from "lucide-svelte";
  import type { api as Api } from "../lib/types";
  import type { BettorStatement } from "../lib/bettor-pdf";
  import { createRequestScope } from "../lib/requests";
  let { period, api: accountApi }: { period: string; api: typeof Api } =
    $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  let controller: AbortController | undefined;
  onDestroy(() => {
    controller?.abort();
    requests.dispose();
  });
  let busy = $state(false),
    error = $state(""),
    status = $state("");
  $effect(() => {
    period;
    untrack(() => {
      controller?.abort();
      status = "";
      error = "";
    });
  });
  function cancelExport() {
    controller?.abort();
    status = "已取消导出";
  }
  async function download() {
    if (busy) return;
    controller = new AbortController();
    const signal = controller.signal;
    const requestedPeriod = period;
    busy = true;
    error = "";
    status = "正在读取账本快照…";
    try {
      const data = await requests.api<BettorStatement>(
        `/periods/${requestedPeriod}/bettor-export`,
        { signal },
      );
      if (!data.bettors.length) throw new Error("本期暂无投注人记录");
      status = "正在准备中文对账单…";
      const { createBettorArchive } = await import("../lib/bettor-pdf");
      signal.throwIfAborted();
      const font = await fetch(fontUrl, { signal });
      if (!font.ok) throw new Error("中文字体加载失败，请重试");
      const bytes = new Uint8Array(await font.arrayBuffer());
      const archive = await createBettorArchive(
        data,
        bytes,
        signal,
        (done, total) => {
          status = `正在生成 PDF：${done} / ${total}`;
        },
      );
      signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(archive)], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `第${requestedPeriod}期-投注人对账单.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status = "已导出全部投注人 PDF";
    } catch (e) {
      if (!signal.aborted)
        error = e instanceof Error ? e.message : "PDF 导出失败";
    } finally {
      busy = false;
    }
  }
</script>

<div class="bettor-export">
  <button class="button secondary" disabled={busy} onclick={download}
    >{#if busy}<LoaderCircle size={16} class="spin" />{:else}<Download
        size={16}
      />{/if}导出全部投注人 PDF</button
  >
  {#if busy}<button class="text-button" onclick={cancelExport}>取消导出</button
    >{/if}
  <span class="field-help" role="status">{busy || !error ? status : ""}</span>
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
</div>
