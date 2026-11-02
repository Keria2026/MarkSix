// Reserve the actual mobile dock height, including every user-opened submenu.
export function reserveNavigationSpace(node: HTMLElement) {
  const shell = node.parentElement!;
  const reserve = () => {
    shell.style.setProperty(
      "--navigation-space",
      `${node.offsetHeight + Math.max(12, parseFloat(getComputedStyle(node).bottom) || 0) + 20}px`,
    );
  };
  const observer = new ResizeObserver(reserve);
  observer.observe(node);
  window.addEventListener("resize", reserve);
  window.visualViewport?.addEventListener("resize", reserve);
  return {
    destroy() {
      observer.disconnect();
      window.removeEventListener("resize", reserve);
      window.visualViewport?.removeEventListener("resize", reserve);
      shell.style.removeProperty("--navigation-space");
    },
  };
}
