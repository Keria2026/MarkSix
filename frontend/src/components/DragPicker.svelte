<script lang="ts">
  import { Check } from "lucide-svelte";
  import { label, options, type Mapping, type Rule } from "../lib/types";
  import { dragPreview, type DragDraft } from "../lib/drag";
  import { parseSelections } from "../lib/selection";
  let {
    rule,
    mapping,
    draft = $bindable(),
  }: { rule: Rule; mapping: Mapping; draft: DragDraft } = $props();
  let side = $state<"left" | "right">("left");
  const kind = $derived(draft.zodiac ? "zodiac" : rule.kind);
  const preview = $derived(dragPreview(rule, draft, mapping));
  const selected = $derived.by(() => {
    try {
      return parseSelections(kind, draft[side]);
    } catch {
      return [];
    }
  });
  function toggle(value: number) {
    const next = selected.includes(value)
      ? selected.filter((n) => n !== value)
      : [...selected, value];
    draft[side] = next.map((n) => label(kind, n)).join(" ");
  }
</script>

<div class="drag-picker">
  {#if rule.kind === "number" && rule.combination_size === 2}
    <div class="segmented" aria-label="拖选项类型">
      <button
        class:active={!draft.zodiac}
        aria-pressed={!draft.zodiac}
        onclick={() => {
          draft = { left: "", right: "", zodiac: false };
        }}>号码</button
      >
      <button
        class:active={draft.zodiac}
        aria-pressed={draft.zodiac}
        onclick={() => {
          draft = { left: "", right: "", zodiac: true };
        }}>生肖展开号码</button
      >
    </div>
  {/if}
  <div class="form-two">
    <label
      >{rule.combination_size === 2 ? "左边选项" : "固定项"}<input
        aria-label="拖左边选项"
        bind:value={draft.left}
        onfocus={() => (side = "left")}
        placeholder={kind === "zodiac" ? "鼠 牛" : "06 18"}
        maxlength="2048"
      /></label
    >
    <label
      >拖项<input
        aria-label="拖右边选项"
        bind:value={draft.right}
        onfocus={() => (side = "right")}
        placeholder={kind === "zodiac" ? "龙 兔 狗" : "27 36"}
        maxlength="2048"
      /></label
    >
  </div>
  <div class="segmented" aria-label="选择拖的哪一边">
    <button
      class:active={side === "left"}
      aria-pressed={side === "left"}
      onclick={() => (side = "left")}
      >{rule.combination_size === 2 ? "选左边" : "选固定项"}</button
    >
    <button
      class:active={side === "right"}
      aria-pressed={side === "right"}
      onclick={() => (side = "right")}>选拖项</button
    >
  </div>
  <div
    class="option-grid"
    class:number-grid={kind === "number"}
    class:zodiac-grid={kind === "zodiac"}
  >
    {#each options(kind) as value}<button
        class="option"
        class:selected={selected.includes(value)}
        aria-pressed={selected.includes(value)}
        onclick={() => toggle(value)}
      >
        <span>{label(kind, value)}</span>
        {#if selected.includes(value)}<span class="selection-check"
            ><Check size={10} /></span
          >{/if}
      </button>{/each}
  </div>
  {#if draft.zodiac && preview.input}<div class="drag-expansion">
      <span>{preview.left.map((n) => label("number", n)).join("、")}</span
      ><strong>拖</strong><span
        >{preview.right.map((n) => label("number", n)).join("、")}</span
      >
    </div>{/if}
  {#if preview.error}<p class="field-help" role="status">
      {preview.error}
    </p>{:else}<p class="field-help">
      {preview.units} 注 · 每注 {rule.combination_size} 项
    </p>{/if}
</div>
