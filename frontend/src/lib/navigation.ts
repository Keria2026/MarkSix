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
