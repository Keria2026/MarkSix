import { cubicOut } from "svelte/easing";

const dialogs: HTMLDialogElement[] = [];
let restore: (() => void) | undefined;

// Native modal dialogs block focus/clicks; also freeze the page for wheel and iOS touch scrolling.
export function lockPage(dialog: HTMLDialogElement) {
  if (!dialogs.length) {
    const { body, documentElement: root } = document;
    const position = { x: window.scrollX, y: window.scrollY };
    const bodyStyle = body.getAttribute("style");
    const rootStyle = root.getAttribute("style");
    const gap = window.innerWidth - root.clientWidth;
    body.style.paddingRight = `${parseFloat(getComputedStyle(body).paddingRight) + gap}px`;
    body.style.position = "fixed";
    body.style.top = `${-position.y}px`;
    body.style.left = `${-position.x}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    const blockBackground = (event: WheelEvent | TouchEvent) => {
      const top = dialogs.at(-1);
      if (!top) return;
      const point = "touches" in event ? event.touches[0] : event;
      const box = top.getBoundingClientRect();
      if (
        !top.contains(event.target as Node) ||
        (event.target === top &&
          point &&
          (point.clientX < box.left ||
            point.clientX > box.right ||
            point.clientY < box.top ||
            point.clientY > box.bottom))
      )
        event.preventDefault();
    };
    document.addEventListener("wheel", blockBackground, {
      passive: false,
      capture: true,
    });
    document.addEventListener("touchmove", blockBackground, {
      passive: false,
      capture: true,
    });
    restore = () => {
      document.removeEventListener("wheel", blockBackground, true);
      document.removeEventListener("touchmove", blockBackground, true);
      if (bodyStyle == null) body.removeAttribute("style");
      else body.setAttribute("style", bodyStyle);
      if (rootStyle == null) root.removeAttribute("style");
      else root.setAttribute("style", rootStyle);
      window.scrollTo(position.x, position.y);
    };
  }
  dialogs.push(dialog);
  const keepFocus = (event: KeyboardEvent) => {
    if (
      event.key !== "Tab" ||
      event.defaultPrevented ||
      dialogs.at(-1) !== dialog
    )
      return;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "a[href], button, input, select, textarea, [tabindex], [contenteditable=true]",
      ),
    )
      .filter(
        (node) =>
          node.tabIndex >= 0 &&
          !node.matches(":disabled") &&
          !node.closest("[inert]") &&
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility !== "hidden",
      )
      .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
    const first = controls[0],
      last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  dialog.addEventListener("keydown", keepFocus);
  return () => {
    const index = dialogs.indexOf(dialog);
    if (index < 0) return;
    dialog.removeEventListener("keydown", keepFocus);
    dialogs.splice(index, 1);
    if (!dialogs.length) {
      restore?.();
      restore = undefined;
    }
  };
}

export function modalMotion(_node: Element) {
  return {
    duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180,
    easing: cubicOut,
    css: (t: number) => `opacity:${t};transform:translateY(${12 * (1 - t)}px)`,
  };
}
