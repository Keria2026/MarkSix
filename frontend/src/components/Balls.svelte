<script lang="ts">
  import { wave, zodiacs } from "../lib/types";
  import type { Mapping } from "../lib/types";
  let {
    numbers = [],
    mapping,
    zodiac,
    waves,
    compact = false,
  }: {
    numbers?: number[];
    mapping?: Mapping;
    zodiac?: number[];
    waves?: number[];
    compact?: boolean;
  } = $props();
</script>

<div
  class:compact
  class="balls"
  aria-label={numbers.length ? "开奖结果" : "等待开奖结果"}
>
  {#each Array.from({ length: 7 }, (_, i) => i) as i}
    {#if i === 6}<span class="ball-plus" aria-hidden="true">+</span>{/if}
    <div class="ball-item" class:special={i === 6}>
      <span
        class="ball"
        class:blank={!numbers[i]}
        data-wave={numbers[i] ? (waves?.[i] ?? wave(numbers[i])) : undefined}
        >{numbers[i] ? String(numbers[i]).padStart(2, "0") : "—"}</span
      >
      {#if !compact}<span class="ball-caption"
          >{numbers[i] && mapping
            ? zodiacs[zodiac?.[i] ?? mapping.zodiac[numbers[i] - 1]]
            : i === 6
              ? "特码"
              : `平码 ${i + 1}`}{#if numbers[i] && i === 6}<small>特码</small
            >{/if}</span
        >{/if}
    </div>
  {/each}
</div>
