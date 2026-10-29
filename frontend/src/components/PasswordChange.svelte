<script lang="ts">
  import { onDestroy } from "svelte";
  import { KeyRound } from "lucide-svelte";
  import type { api as Api } from "../lib/types";
  import { createRequestScope } from "../lib/requests";
  import Modal from "./Modal.svelte";
  let {
    api: accountApi,
    onchanged,
  }: { api: typeof Api; onchanged: () => Promise<void> } = $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  onDestroy(requests.dispose);
  let open = $state(false),
    busy = $state(false),
    error = $state("");
  let oldPassword = $state(""),
    newPassword = $state(""),
    confirmation = $state("");
  function close() {
    if (busy) return;
    open = false;
    oldPassword = "";
    newPassword = "";
    confirmation = "";
    error = "";
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    if (newPassword !== confirmation) {
      error = "两次新密码不一致";
      return;
    }
    if (newPassword === oldPassword) {
      error = "新密码不能与原密码相同";
      return;
    }
    busy = true;
    try {
      await requests.api("/account/password", {
        method: "POST",
        body: JSON.stringify({
          old_password: oldPassword,
          new_password: newPassword,
        }),
      });
      oldPassword = "";
      newPassword = "";
      confirmation = "";
      open = false;
      await onchanged();
    } catch (e) {
      oldPassword = "";
      error = e instanceof Error ? e.message : "密码修改失败";
    } finally {
      busy = false;
    }
  }
</script>

<section class="glass account-security">
  <div class="section-head"><h2><KeyRound size={19} />账号安全</h2></div>

  <button class="button secondary" onclick={() => (open = true)}
    >修改登录密码</button
  >
</section>
{#if open}<Modal title="修改登录密码" dismissible={!busy} onclose={close}>
    <form class="rule-form" onsubmit={save}>
      <label
        >原密码<input
          type="password"
          bind:value={oldPassword}
          autocomplete="current-password"
          required
          maxlength="256"
          disabled={busy}
        /></label
      >
      <label
        >新密码<input
          type="password"
          bind:value={newPassword}
          autocomplete="new-password"
          required
          minlength="12"
          maxlength="256"
          disabled={busy}
        /></label
      >
      <label
        >再次输入新密码<input
          type="password"
          bind:value={confirmation}
          autocomplete="new-password"
          required
          minlength="12"
          maxlength="256"
          disabled={busy}
        /></label
      >
      <p class="field-help">修改后需重新登录，未使用的旧激活码失效。</p>
      {#if error}<p class="form-error" role="alert">{error}</p>{/if}
      <div class="modal-actions">
        <button
          type="button"
          class="button secondary"
          disabled={busy}
          onclick={close}>取消</button
        ><button class="button primary" disabled={busy}
          >{busy ? "正在修改…" : "确认修改密码"}</button
        >
      </div>
    </form>
  </Modal>{/if}
