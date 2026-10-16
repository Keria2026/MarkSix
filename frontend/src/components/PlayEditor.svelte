<script lang="ts">
  import { AlertCircle, LoaderCircle, Check } from "lucide-svelte";
  import Modal from "./Modal.svelte";
  import { kinds, scopes, conditions, relations, options } from "../lib/types";
  import type { Play, Rule, Kind, api as Api } from "../lib/types";
  let {
    play,
    api,
    onclose,
    onsaved,
    ondelete,
    onexport,
  }: {
    play: Play | null;
    api: typeof Api;
    onclose: () => void;
    onsaved: () => Promise<void>;
    ondelete: (play: Play) => void;
    onexport: (id: number) => Promise<void>;
  } = $props();
  let busy = $state(false),
    editError = $state("");
  const editId = $derived(play?.id ?? null),
    editVersion = $derived(play?.version ?? 0);
  let enabled = $state(true);
  let rule = $state<Rule>(newRule());
  // Each opening mounts a new editor with a frozen rule/version snapshot.
  $effect(() => {
    rule = structuredClone($state.snapshot(play?.rule ?? newRule()));
    enabled = play?.enabled ?? true;
  });
  function newRule(): Rule {
    return {
      name: "",
      kind: "number",
      scope: "special",
      condition: "all",
      relation: "eq",
      quantity: 1,
      combination_size: 1,
      compound_enabled: false,
      selection_limit: null,
      zodiac_count: null,
      special_hit_odds: null,
      minimum_hits: 1,
      odds: "43",
      rebate_percent: "2",
      special_odds: null,
      zero_tail_odds: null,
      special_rebate_percent: null,
    };
  }
  function changeCondition(value: Rule["condition"]) {
    rule.condition = value;
    if (value === "hard_pair" || value === "soft_pair")
      rule.zero_tail_odds = null;
    if (rule.condition === "hard_pair" || rule.condition === "soft_pair") {
      rule.kind = "number";
      rule.scope = "all";
      rule.relation = "eq";
      rule.quantity = 2;
      rule.combination_size = 2;
      rule.compound_enabled = false;
    }
  }
  function changeKind(value: Kind) {
    rule.kind = value;
    if (value !== "tail") rule.zero_tail_odds = null;
    rule.zodiac_count = null;
    rule.special_hit_odds = null;
    rule.selection_limit = null;
    rule.quantity = 1;
    rule.combination_size = 1;
    if (value === "wave") rule.scope = "special";
    if (value === "zodiac_count") {
      rule.zodiac_count = 4;
      rule.scope = "all";
      rule.condition = "all";
      rule.relation = "eq";
      rule.compound_enabled = false;
      rule.selection_limit = 1;
    }
    if (value === "wave" || value === "zodiac_count") {
      rule.special_odds = null;
      rule.special_rebate_percent = null;
    }
    if (["hard_pair", "soft_pair"].includes(rule.condition))
      rule.condition = "all";
  }
  async function savePlay(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    editError = "";
    if (!rule.compound_enabled) rule.combination_size = rule.quantity;
    if (
      !(
        rule.kind === "number" &&
        rule.scope === "all" &&
        rule.condition === "all" &&
        rule.relation === "eq" &&
        rule.quantity === 2 &&
        rule.combination_size === 2
      )
    )
      rule.special_hit_odds = null;
    try {
      await api(editId ? `/plays/${editId}` : "/plays", {
        method: editId ? "PUT" : "POST",
        body: JSON.stringify(
          editId ? { version: editVersion, rule, enabled } : rule,
        ),
      });
      await onsaved();
      onclose();
    } catch (e) {
      editError = e instanceof Error ? e.message : "保存失败";
    } finally {
      busy = false;
    }
  }
</script>

<Modal title={editId ? "编辑玩法" : "新建玩法"} {onclose}
  ><form onsubmit={savePlay} class="rule-form">
    <label
      >玩法名称<input
        bind:value={rule.name}
        required
        maxlength="40"
        placeholder="例如：五有"
      /></label
    >
    <div class="form-two">
      <label
        >投注对象<select
          aria-label="投注对象"
          value={rule.kind}
          onchange={(e) => changeKind(e.currentTarget.value as Kind)}
          >{#each Object.entries(kinds) as [key, value]}<option value={key}
              >{value}</option
            >{/each}</select
        ></label
      ><label
        >开奖对比范围<select
          bind:value={rule.scope}
          disabled={rule.kind === "wave" || rule.kind === "zodiac_count"}
          >{#each Object.entries(scopes) as [key, value]}<option value={key}
              >{value}</option
            >{/each}</select
        ></label
      >
    </div>
    <label
      >命中条件<select
        value={rule.condition}
        disabled={rule.kind === "zodiac_count"}
        onchange={(e) =>
          changeCondition(e.currentTarget.value as Rule["condition"])}
        >{#each Object.entries(conditions) as [key, value]}<option value={key}
            >{value}</option
          >{/each}</select
      ></label
    >
    {#if rule.kind === "zodiac_count"}<label
        >目标生肖种数<input
          type="number"
          min="1"
          max="7"
          bind:value={rule.zodiac_count}
          required
        /></label
      >
      <p class="field-help">
        判断全部 7 球恰好开出几种不同生肖，投注时无需逐个选择生肖。
      </p>{/if}
    {#if rule.condition === "at_least"}<label
        >最少命中数量<input
          type="number"
          min="1"
          max="49"
          bind:value={rule.minimum_hits}
          required
        /></label
      >{/if}
    <label
      >最多可选数量（留空允许普通多选）<input
        type="number"
        min="1"
        max={options(rule.kind).length}
        value={rule.selection_limit ?? ""}
        oninput={(event) =>
          (rule.selection_limit = event.currentTarget.value
            ? Number(event.currentTarget.value)
            : null)}
      /></label
    >
    <label class="checkbox-label"
      ><input
        type="checkbox"
        bind:checked={rule.compound_enabled}
        disabled={rule.kind === "zodiac_count" ||
          rule.condition === "hard_pair" ||
          rule.condition === "soft_pair"}
      /> 启用复式投注</label
    >
    <div class="form-three">
      <label
        >数量关系<select
          bind:value={rule.relation}
          disabled={rule.kind === "zodiac_count"}
          >{#each Object.entries(relations) as [key, value]}<option value={key}
              >{value}</option
            >{/each}</select
        ></label
      ><label
        >数量阈值<input
          type="number"
          min="1"
          max="49"
          bind:value={rule.quantity}
          disabled={rule.kind === "zodiac_count"}
          required
        /></label
      ><label
        >复式每注选项数<input
          disabled={!rule.compound_enabled}
          type="number"
          min="1"
          max="49"
          bind:value={rule.combination_size}
          required
        /></label
      >
    </div>
    <p class="field-help">
      普通投注须满足数量关系；单选玩法可多选逐项拆注。“不少于 5”选 7 个拆成 21
      注。“等于 5”未开复式时只能选 5
      个。最多可选数量对普通和复式均生效；复式拆分后的每注也须满足规则。
    </p>
    <div class="form-two">
      <label
        >含本赔率<input
          inputmode="decimal"
          bind:value={rule.odds}
          required
          placeholder="最多四位小数"
        /></label
      ><label
        >反水比例（%）<input
          inputmode="decimal"
          bind:value={rule.rebate_percent}
          required
          placeholder="0–100，最多两位小数"
        /></label
      >
    </div>
    {#if rule.kind === "number" && rule.scope === "all" && rule.condition === "all" && rule.relation === "eq" && rule.quantity === 2}<label
        class="checkbox-label"
        ><input
          type="checkbox"
          checked={rule.special_hit_odds != null}
          onchange={(e) =>
            (rule.special_hit_odds = e.currentTarget.checked ? "25" : null)}
        />启用一特一平赔率</label
      >{#if rule.special_hit_odds != null}<label
          >一特一平含本赔率<input
            inputmode="decimal"
            bind:value={rule.special_hit_odds}
            required
          /></label
        >
        <p class="field-help">
          两平码中奖沿用上方普通含本赔率；一号为特码、另一号为平码时使用此赔率，逐条基础注分别结算。
        </p>{/if}{/if}
    {#if rule.kind === "tail"}
      <label class="checkbox-label"
        ><input
          type="checkbox"
          checked={rule.zero_tail_odds != null}
          onchange={(e) =>
            (rule.zero_tail_odds = e.currentTarget.checked ? rule.odds : null)}
        />启用 0 尾特殊赔率</label
      >
      {#if rule.zero_tail_odds != null}<label
          >0 尾含本赔率<input
            inputmode="decimal"
            bind:value={rule.zero_tail_odds}
            required
            placeholder="最多四位小数"
          /></label
        >
        <p class="field-help">
          0 尾只有 10、20、30、40 四个号码。拆分后含 0
          尾的基础注使用此赔率；与本命肖特殊赔率重叠时优先使用 0
          尾赔率，反水仍按原规则。
        </p>{/if}
    {/if}
    {#if rule.kind !== "wave" && rule.kind !== "zodiac_count"}<label
        class="checkbox-label"
        ><input
          type="checkbox"
          checked={rule.special_odds !== null}
          onchange={(e) =>
            (rule.special_odds = e.currentTarget.checked ? "8" : null)}
        /> 启用本命生肖特殊赔率</label
      >{#if rule.special_odds !== null}<label
          >特殊含本赔率<input
            inputmode="decimal"
            bind:value={rule.special_odds}
            required
          /></label
        >
        <p class="field-help">
          按每条基础注是否包含本命生肖分别应用，全部不命中玩法同样适用。
        </p>{/if}
      <label class="checkbox-label"
        ><input
          type="checkbox"
          checked={rule.special_rebate_percent !== null}
          onchange={(e) =>
            (rule.special_rebate_percent = e.currentTarget.checked
              ? "0"
              : null)}
        /> 启用本命肖特殊反水</label
      >
      {#if rule.special_rebate_percent !== null}<label
          >本命肖反水（%）<input
            inputmode="decimal"
            bind:value={rule.special_rebate_percent}
            required
          /></label
        >{/if}
      <p class="field-help">
        号码、生肖、尾数、大小、单双均按当期映射逐条判断；含本命肖对应选项的基础注采用特殊值。
      </p>
    {/if}{#if editId}<label class="checkbox-label"
        ><input type="checkbox" bind:checked={enabled} /> 允许录入新投注</label
      >{/if}{#if editError}<div class="inline-error" role="alert">
        <AlertCircle size={16} />{editError}
      </div>{/if}
    <div class="modal-actions">
      {#if editId}<button
          type="button"
          class="button danger"
          disabled={busy}
          onclick={() => play && ondelete(play)}>删除玩法</button
        >
        <button
          type="button"
          class="button secondary"
          onclick={() => onexport(editId!)}>导出此玩法</button
        >{/if}
      <button type="button" class="button secondary" onclick={onclose}
        >取消</button
      ><button class="button primary" disabled={busy}
        >{#if busy}<LoaderCircle size={16} class="spin" />{:else}<Check
            size={16}
          />{/if}保存玩法</button
      >
    </div>
  </form></Modal
>
