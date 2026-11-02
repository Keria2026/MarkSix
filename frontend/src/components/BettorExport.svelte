<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import fontUrl from "../assets/NotoSansSC-Regular.ttf?url";
  import { Download, LoaderCircle, X } from "lucide-svelte";
  import type { api as Api } from "../lib/types";
  import type { BettorStatement, StatementFormat } from "../lib/statement";
  import { createRequestScope } from "../lib/requests";
  let {
    period,
    api: accountApi,
    busy = $bindable(false),
  }: { period: string; api: typeof Api; busy?: boolean } = $props();
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
  let error = $state(""),
    status = $state("");
  let observedPeriod = untrack(() => period);
  $effect(() => {
    const next = period;
    untrack(() => {
      if (next === observedPeriod) return;
      observedPeriod = next;
      controller?.abort();
      status = "";
      error = "";
    });
  });
  function cancelExport() {
    controller?.abort();
    status = "已取消导出";
  }
  export async function download(bettor?: string) {
    if (busy) return;
    controller = new AbortController();
    const signal = controller.signal;
    const requestedPeriod = period;
    const requestedFormat = format;
    const formatLabel =
      requestedFormat === "xlsx" ? "Excel" : requestedFormat.toUpperCase();
    busy = true;
    error = "";
    status = "正在读取账单…";
    try {
      const data = await requests.api<BettorStatement>(
        `/periods/${requestedPeriod}/bettor-export?combined=true`,
        { signal },
      );
      if (!data.bettors.length) throw new Error("本期暂无投注人记录");
      status =
        requestedFormat === "xlsx"
          ? "正在准备 Excel 账单…"
          : "正在准备中文对账单…";
      const { createBettorArchive, createBettorFile } = await import(
        "../lib/statement-export"
      );
      signal.throwIfAborted();
      let bytes = new Uint8Array();
      if (requestedFormat !== "xlsx") {
        const font = await fetch(fontUrl, { signal });
        if (!font.ok) throw new Error("中文字体加载失败，请重试");
        bytes = new Uint8Array(await font.arrayBuffer());
      }
      const progress = (done: number, total: number) => {
        status = `正在生成 ${formatLabel}：${done} / ${total}`;
      };
      const file =
        bettor === undefined
          ? {
              name: `${data.business_date ?? requestedPeriod}-投注人对账单-${requestedFormat}.zip`,
              bytes: await createBettorArchive(
                data,
                bytes,
                signal,
                progress,
                requestedFormat,
              ),
            }
          : await createBettorFile(
              data,
              bettor,
              bytes,
              signal,
              progress,
              requestedFormat,
            );
      signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(file.bytes)], {
          type:
            bettor === undefined
              ? "application/zip"
              : requestedFormat === "pdf"
                ? "application/pdf"
                : requestedFormat === "xlsx"
                  ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  : "image/png",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status = `已导出${bettor === undefined ? "全部投注人" : `「${bettor}」`} ${formatLabel} 账单`;
    } catch (e) {
      if (!signal.aborted)
        error = e instanceof Error ? e.message : "账单导出失败";
    } finally {
      busy = false;
    }
  }
</script>

<div class="bettor-export" aria-busy={busy}>
  <label class="export-format"
    ><span class="sr-only">导出格式</span>
    <select aria-label="账单导出格式" bind:value={format} disabled={busy}>
      <option value="pdf">PDF 文档</option>
      <option value="png">PNG 图片</option>
      <option value="xlsx">Excel 表格</option>
    </select>
  </label>
  <button
    class="button secondary"
    aria-label="导出账单（全部投注人）"
    disabled={busy}
    onclick={() => download()}
    >{#if busy}<LoaderCircle size={16} class="spin" />{:else}<Download
        size={16}
      />{/if}导出账单</button
  >
</div>
<div class="export-notice toast glass" class:visible={!!(status || error)}>
  <div class="export-notice-message">
    <p role="status" aria-atomic="true">{error ? "" : status}</p>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  </div>
  {#if busy}
    <button class="text-button" onclick={cancelExport}>取消导出</button>
  {:else}
    <button
      class="icon-button"
      aria-label="关闭导出提示"
      onclick={() => {
        status = "";
        error = "";
      }}><X size={18} /></button
    >
  {/if}
</div>
