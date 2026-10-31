<script lang="ts">
  import { onDestroy } from "svelte";
  import Modal from "./Modal.svelte";
  import { kinds, scopes, conditions, relations } from "../lib/types";
  import type { api as Api } from "../lib/types";
  import { createRequestScope } from "../lib/requests";

  let {
    action,
    targets,
    api: accountApi,
    onclose,
    onsaved,
  }: {
    action: "update" | "delete";
    targets: { id: number; version: number }[];
    api: typeof Api;
    onclose: () => void;
    onsaved: () => Promise<void>;
  } = $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  onDestroy(requests.dispose);
  let busy = $state(false),
    error = $state("");
  let odds = $state(""),
    rebate = $state(""),
    enabled = $state("");
  let values = $state<Record<string, string>>({});
  let cleared = $state<Record<string, boolean>>({});
  type Field = {
    key: string;
    label: string;
    choices?: Record<string, string>;
    decimal?: boolean;
    nullable?: boolean;
  };
  const groups: { title: string; fields: Field[] }[] = [
    {
      title: "开奖、数量与复式",
      fields: [
        { key: "kind", label: "投注对象", choices: kinds },
        { key: "scope", label: "开奖对比范围", choices: scopes },
        { key: "condition", label: "命中条件", choices: conditions },
        { key: "relation", label: "数量关系", choices: relations },
        { key: "quantity", label: "数量阈值" },
        { key: "combination_size", label: "每注选项数" },
        {
          key: "compound_enabled",
          label: "复式状态",
          choices: { true: "启用复式", false: "关闭复式" },
        },
        { key: "minimum_hits", label: "最少命中数" },
        { key: "selection_limit", label: "最多可选数量", nullable: true },
        { key: "zodiac_count", label: "目标生肖种数", nullable: true },
      ],
    },
    {
      title: "特殊赔率与反水",
      fields: [
        {
          key: "special_odds",
          label: "本命肖特殊赔率",
          decimal: true,
          nullable: true,
        },
        {
          key: "special_rebate_percent",
          label: "本命肖特殊反水（%）",
          decimal: true,
          nullable: true,
        },
        {
          key: "zero_tail_odds",
          label: "0 尾特殊赔率",
          decimal: true,
          nullable: true,
        },
        {
          key: "zero_tail_rebate_percent",
          label: "0 尾特殊反水（%）",
          decimal: true,
          nullable: true,
        },
        {
          key: "special_hit_odds",
          label: "一特一平赔率",
          decimal: true,
          nullable: true,
        },
      ],
    },
  ];
  async function save(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    const rule: Record<string, string | number | boolean | null> = {};
    for (const field of groups.flatMap((group) => group.fields)) {
      const value = values[field.key]?.trim() ?? "";
      if (cleared[field.key]) rule[field.key] = null;
      else if (value) {
        if (field.key === "compound_enabled")
          rule[field.key] = value === "true";
        else if (field.choices || field.decimal) rule[field.key] = value;
        else {
          if (!/^\d+$/.test(value)) {
            error = `${field.label}须为整数`;
            return;
          }
          rule[field.key] = Number(value);
        }
      }
    }
    busy = true;
    try {
      await requests.api("/plays/batch", {
        method: "POST",
        body: JSON.stringify({
          targets,
          action,
          ...(action === "update"
            ? {
                odds: odds.trim() || null,
                rebate_percent: rebate.trim() || null,
                enabled: enabled === "" ? null : enabled === "true",
                rule,
              }
            : {}),
        }),
      });
      await onsaved();
    } catch (e) {
      error = e instanceof Error ? e.message : "保存失败，请重试";
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  title={action === "delete" ? "批量删除玩法" : "批量调整玩法"}
  {onclose}
  dismissible={!busy}
>
  <form class="rule-form" onsubmit={save}>
    <p class="modal-description">
      已选择 {targets.length} 条玩法
    </p>
    {#if action === "delete"}<p class="inline-error">
        这些玩法将停止录入，历史投注及统计保留。
      </p>
    {:else}
      <div class="form-two">
        <label
          >批量含本赔率<input
            bind:value={odds}
            inputmode="decimal"
            placeholder="留空不修改"
            disabled={busy}
          /></label
        >
        <label
          >批量反水比例（%）<input
            bind:value={rebate}
            inputmode="decimal"
            placeholder="留空不修改"
            disabled={busy}
          /></label
        >
      </div>
      <label
        >批量启用状态<select bind:value={enabled} disabled={busy}
          ><option value="">保持原状</option><option value="true"
            >全部启用</option
          ><option value="false">全部停用</option></select
        ></label
      >
      {#each groups as group}<details class="batch-section">
          <summary>{group.title}</summary>
          <div class="form-two">
            {#each group.fields as field}<div class="batch-field">
                <label for={`batch-${field.key}`}>{`批量${field.label}`}</label>
                {#if field.choices}<select
                    id={`batch-${field.key}`}
                    bind:value={values[field.key]}
                    disabled={busy}
                  >
                    <option value="">保持原状</option>
                    {#each Object.entries(field.choices) as [value, name]}<option
                        {value}>{name}</option
                      >{/each}
                  </select>{:else}<input
                    id={`batch-${field.key}`}
                    bind:value={values[field.key]}
                    inputmode={field.decimal ? "decimal" : "numeric"}
                    placeholder="留空不修改"
                    disabled={busy || cleared[field.key]}
                  />{/if}
                {#if field.nullable}<label class="checkbox-line batch-clear"
                    ><input
                      type="checkbox"
                      bind:checked={cleared[field.key]}
                      disabled={busy}
                    />清除{field.label}</label
                  >{/if}
              </div>{/each}
          </div>
        </details>{/each}
    {/if}
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
    <div class="modal-actions">
      <button
        type="button"
        class="button secondary"
        disabled={busy}
        onclick={onclose}>取消</button
      >
      <button
        class={action === "delete" ? "button danger" : "button primary"}
        disabled={busy || !targets.length}
        >{busy
          ? "正在保存…"
          : action === "delete"
            ? "确认批量删除"
            : "保存批量调整"}</button
      >
    </div>
  </form>
</Modal>
