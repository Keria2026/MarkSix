<script lang="ts">
  import { AlertCircle, Clock3, Info } from "lucide-svelte";
  import Balls from "./Balls.svelte";
  import {
    marketName,
    type DrawPeriod,
    type Mapping,
    type Market,
  } from "../lib/types";
  let {
    period,
    market,
    mapping,
  }: { period?: DrawPeriod; market: Market; mapping: Mapping } = $props();
</script>

<section class="draw-panel glass" aria-label={`${marketName(market)}开奖`}>
  <div class="section-head">
    <div>
      <h2>{marketName(market)}开奖</h2>
      {#if period?.draw}<small
          >第 {period.draw.expect} 期 · {period.draw.open_time.slice(
            0,
            10,
          )}</small
        >{/if}
    </div>
    <span class="soft-chip"
      ><Clock3 size={13} />{period?.draw
        ? period.draw.open_time.slice(11, 16)
        : "21:34 自动同步"}</span
    >
  </div>
  <Balls
    numbers={period?.draw?.numbers}
    mapping={period?.mapping ?? mapping}
    zodiac={period?.draw?.zodiac}
    waves={period?.draw?.waves}
  />
  {#if market === "hk" && !period}<p class="field-help">
      当日暂无香港投注
    </p>{/if}
  {#if period?.error}<div class="inline-error subtle">
      <AlertCircle size={15} />{period.error}
    </div>{/if}
  {#if period?.mapping_warning}<div class="inline-error subtle">
      <Info size={15} />接口映射与配置存在差异，已按接口实际数据结算。
    </div>{/if}
</section>
