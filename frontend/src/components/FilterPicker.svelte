<script lang="ts" generics="T extends string | number">
  import { ChevronDown } from "lucide-svelte";
  let {
    label,
    options,
    selected = $bindable(),
    disabled = false,
  }: {
    label: string;
    options: { value: T; label: string }[];
    selected: T[];
    disabled?: boolean;
  } = $props();
  const id = $props.id();
  let expanded = $state(false);
  let search = $state("");
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  const visible = $derived(
    options.filter((option) => option.label.includes(search.trim())),
  );
  function close() {
    expanded = false;
    search = "";
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (expanded && !root.contains(event.target as Node)) close();
  }}
  onkeydown={(event) => {
    if (expanded && event.key === "Escape") {
      event.preventDefault();
      close();
      trigger.focus();
    }
  }}
/>
<div
  class="filter-picker"
  bind:this={root}
  onfocusout={(event) => {
    if (event.relatedTarget && !root.contains(event.relatedTarget as Node))
      close();
  }}
>
  <span class="filter-label">{label}</span>
  <button
    bind:this={trigger}
    type="button"
    class="filter-trigger"
    {disabled}
    aria-label={`${label}：${selected.length ? `已选 ${selected.length} 项` : "全部"}`}
    aria-expanded={expanded}
    aria-controls={expanded ? id : undefined}
    onclick={() => {
      expanded = !expanded;
      search = "";
    }}
  >
    <span>{selected.length ? `已选 ${selected.length} 项` : "全部"}</span
    ><ChevronDown size={16} />
  </button>
  {#if expanded}
    <div {id} class="filter-options" role="group" aria-label={`${label}选项`}>
      {#if options.length > 6}<input
          type="search"
          aria-label={`搜索${label}`}
          placeholder={`搜索${label}`}
          bind:value={search}
        />{/if}
      <div class="filter-option-list">
        {#each visible as option (option.value)}
          <label class="checkbox-label"
            ><input
              type="checkbox"
              value={option.value}
              bind:group={selected}
            />{option.label}</label
          >
        {/each}
        {#if !visible.length}<p class="field-help">
            {options.length ? "没有匹配的选项" : `本期暂无${label}`}
          </p>{/if}
      </div>
      <div class="filter-options-footer">
        <button
          type="button"
          class="text-button"
          onclick={() => (selected = [])}>清除选择</button
        ><button
          type="button"
          class="text-button"
          onclick={() => {
            close();
            trigger.focus();
          }}>完成</button
        >
      </div>
    </div>
  {/if}
</div>
