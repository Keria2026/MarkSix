<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import fontUrl from "../assets/NotoSansSC-Regular.ttf?url";
  import { Download, LoaderCircle } from "lucide-svelte";
  import type { api as Api } from "../lib/types";
  import type {
    BettorStatement,
    StatementFormat,
  } from "../lib/bettor-statement";
  import { createRequestScope } from "../lib/requests";
  let { period, api: accountApi }: { period: string; api: typeof Api } =
    $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  let controller: AbortController | undefined;
  let format = $state<StatementFormat>("pdf");
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
    const requestedFormat = format;
    busy = true;
    error = "";
    status = "正在读取账单…";
    try {
      const data = await requests.api<BettorStatement>(
        `/periods/${requestedPeriod}/bettor-export`,
        { signal },
      );
      if (!data.bettors.length) throw new Error("本期暂无投注人记录");
      status = "正在准备中文对账单…";
      const { createBettorArchive } = await import("../lib/bettor-statement");
      signal.throwIfAborted();
      const font = await fetch(fontUrl, { signal });
      if (!font.ok) throw new Error("中文字体加载失败，请重试");
      const bytes = new Uint8Array(await font.arrayBuffer());
      const archive = await createBettorArchive(
        data,
        bytes,
        signal,
        (done, total) => {
          status = `正在生成 ${requestedFormat.toUpperCase()}：${done} / ${total}`;
        },
        requestedFormat,
      );
      signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(archive)], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `第${requestedPeriod}期-投注人对账单-${requestedFormat}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status = `已导出全部投注人 ${requestedFormat.toUpperCase()} 账单`;
    } catch (e) {
      if (!signal.aborted)
        error = e instanceof Error ? e.message : "账单导出失败";
    } finally {
      busy = false;
    }
  }
</script>

<div class="bettor-export">
  <label class="export-format"
    >导出格式
    <select aria-label="账单导出格式" bind:value={format} disabled={busy}>
      <option value="pdf">PDF 文档</option>
      <option value="png">PNG 图片</option>
    </select>
  </label>
  <button class="button secondary" disabled={busy} onclick={download}
    >{#if busy}<LoaderCircle size={16} class="spin" />{:else}<Download
        size={16}
      />{/if}导出全部投注人账单</button
  >
  {#if busy}<button class="text-button" onclick={cancelExport}>取消导出</button
    >{/if}
  <span class="field-help" role="status">{busy || !error ? status : ""}</span>
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
</div>
