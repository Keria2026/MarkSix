import { tick } from "svelte";

// Keep one glass surface aligned with the active button as the layout changes.
export function glassNavigation(node: HTMLElement, current: string) {
  const indicator = node.querySelector<HTMLElement>(".nav-indicator")!;
  let frame = 0;
  let destroyed = false;
  let ready = false;
  const measure = () => {
    if (destroyed) return;
    const target = node.querySelector<HTMLElement>(
      ":scope > .nav-item > button[aria-current='page']",
    );
    if (!target) return;
    const box = target.getBoundingClientRect();
    const parent = node.getBoundingClientRect();
    indicator.style.width = `${target.offsetWidth}px`;
    indicator.style.height = `${target.offsetHeight}px`;
    indicator.style.transform = `translate(${box.left - parent.left + node.scrollLeft}px, ${box.top - parent.top + node.scrollTop}px)`;
    if (!ready) {
      ready = true;
      // Commit the initial position before enabling transitions.
      indicator.getBoundingClientRect();
      indicator.dataset.ready = "true";
    }
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(node);
  const mutation = new MutationObserver(schedule);
  mutation.observe(node, { childList: true, subtree: true });
  const update = async (_current: string) => {
    await tick();
    if (!destroyed) schedule();
  };
  void update(current);
  return {
    update,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    },
  };
}

// Animate the existing page without replacing form controls or keyboard focus.
export function pageFade(node: HTMLElement, key: string) {
  let current = key;
  let animation: Animation | undefined;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const stop = () => animation?.cancel();
  reduced.addEventListener("change", stop);
  return {
    update(next: string) {
      if (next === current) return;
      current = next;
      stop();
      if (!reduced.matches)
        animation = node.animate(
          [{ opacity: 1 }, { opacity: 0.58, offset: 0.3 }, { opacity: 1 }],
          { duration: 260, easing: "ease-out" },
        );
    },
    destroy() {
      stop();
      reduced.removeEventListener("change", stop);
    },
  };
}

// Reserve the actual mobile dock height, including every user-opened submenu.
export function reserveNavigationSpace(node: HTMLElement) {
  const shell = node.parentElement!;
  const observer = new ResizeObserver(() => {
    shell.style.setProperty(
      "--navigation-space",
      `${node.offsetHeight + 28}px`,
    );
  });
  observer.observe(node);
  return {
    destroy() {
      observer.disconnect();
      shell.style.removeProperty("--navigation-space");
    },
  };
}
