<script lang="ts">
  import Modal from "./Modal.svelte";
  import { Check, Users } from "lucide-svelte";
  import {
    recordViews,
    type RecordView,
    type Collaboration,
  } from "../lib/collaboration";
  let {
    username,
    collaboration,
    view,
    editing = false,
    onchange,
  }: {
    username: string;
    collaboration: Collaboration;
    view: RecordView;
    editing?: boolean;
    onchange: (view: RecordView) => void;
  } = $props();
  let open = $state(false);
</script>

<button
  class="avatar scope-avatar"
  aria-label="切换记录范围"
  title="切换记录范围"
  onclick={() => (open = true)}
>
  {Array.from(username)[0]?.toUpperCase() ?? "A"}
</button>
{#if open}
  <Modal title="记录范围" onclose={() => (open = false)}>
    <p class="scope-members">
      <Users size={17} />{collaboration.members
        .map((m) => m.username)
        .join("、")}
    </p>
    {#if editing}<p class="field-help">
        切换将关闭当前录入页面，请先保存需要保留的投注。
      </p>{/if}
    <div class="scope-options">
      {#each recordViews as option}
        <button
          class="button secondary"
          aria-pressed={view === option.id}
          onclick={() => {
            open = false;
            if (option.id !== view) onchange(option.id);
          }}
        >
          <span
            >{option.label}{#if option.id === "history"}<small
                >各自保留，仅供查看</small
              >{/if}</span
          >
          {#if view === option.id}<Check size={18} />{/if}
        </button>
      {/each}
    </div>
  </Modal>
{/if}

<style>
  .scope-avatar {
    border: 0;
    cursor: pointer;
    flex-shrink: 0;
    min-width: 44px;
    min-height: 44px;
  }
  .scope-members {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow-wrap: anywhere;
  }
  .scope-options {
    display: grid;
    gap: 12px;
    margin-top: 16px;
  }
  .scope-options button {
    justify-content: space-between;
    width: 100%;
    text-align: left;
    min-height: 52px;
  }
  .scope-options small {
    display: block;
    margin-top: 4px;
    color: var(--muted);
  }
  .scope-options [aria-pressed="true"] {
    color: var(--blue);
    background: #eaf0ff;
  }
</style>
