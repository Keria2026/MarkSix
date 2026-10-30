import { entryCents } from "../types";
import type { Play } from "../types";
import type { TextPreference } from "../text-entry";
import { parseText } from "./parser";
import { tokenize } from "./lexer";

export function clipboardRows(
  text: string,
  plays: Play[],
  habits: TextPreference[],
) {
  if (!text.trim() || text.length > 12000) return null;
  let rows;
  try {
    rows = parseText(text, plays, habits);
  } catch {
    return null;
  }
  return rows.some((row) => {
    if (!row.playLabel || row.customAlias || entryCents(row.amount) === null)
      return false;
    const tokens = tokenize(row.body, []);
    return (
      tokens.some((t) => t.kind === "number" || t.kind === "object") &&
      !tokens.some((t) => t.kind === "unknown" && /[\p{L}\p{N}]/u.test(t.text))
    );
  })
    ? rows
    : null;
}

export const textFingerprint = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export function watchClipboard(
  account: string,
  available: () => boolean,
  offer: (text: string) => boolean,
  notify: (message: string) => void,
) {
  const storageKey = `marksix:last-text:${encodeURIComponent(account)}`;
  let disposed = false,
    reading = false,
    blocked = false;
  let recorded = "",
    timer: ReturnType<typeof setTimeout>;
  try {
    recorded = localStorage.getItem(storageKey) ?? "";
  } catch {
    /* Storage may be disabled. */
  }
  async function check(manual = false) {
    if (
      disposed ||
      reading ||
      (!manual && blocked) ||
      document.hidden ||
      !document.hasFocus() ||
      !available()
    )
      return;
    reading = true;
    try {
      const text = await navigator.clipboard.readText();
      if (disposed || document.hidden || !document.hasFocus() || !available())
        return;
      const hash = await textFingerprint(text);
      if (disposed || document.hidden || !document.hasFocus() || !available())
        return;
      // Only the latest successfully recorded text survives a refresh.
      try {
        recorded = localStorage.getItem(storageKey) ?? recorded;
      } catch {
        /* Keep session deduplication. */
      }
      if (hash === recorded) return;
      if (!offer(text) && manual) notify("剪切板没有可识别的投注文本");
      blocked = false;
    } catch {
      if (!disposed && (!blocked || manual))
        notify("浏览器未允许读取剪切板，请点击顶部的读取剪切板按钮授权");
      blocked = true;
    } finally {
      reading = false;
    }
  }
  function foreground() {
    clearTimeout(timer);
    timer = setTimeout(() => void check(), 80);
  }
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", foreground);
  function rememberFingerprint(hash: string) {
    recorded = hash;
    localStorage.setItem(storageKey, recorded);
  }
  return {
    check,
    rememberFingerprint,
    async remember(text: string) {
      rememberFingerprint(await textFingerprint(text));
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    },
  };
}
