// Decorative optics follow the existing buttons; their own click/keyboard
// handlers remain the only source of navigation and submenu state.
function displacementMap(width: number, height: number) {
  const canvas = document.createElement("canvas");
  const ratio = Math.min(2, 256 / width);
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d")!;
  const pixels = context.createImageData(canvas.width, canvas.height);
  const radius = height / 2;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const dx = (x + 0.5) / ratio - width / 2;
      const dy = (y + 0.5) / ratio - height / 2;
      const nx = Math.max(Math.abs(dx) - (width / 2 - radius), 0);
      const length = Math.hypot(nx, dy);
      const distance = length - radius;
      const rim = Math.max(0, Math.min(1, 1 + distance / 11));
      const bend = distance <= 0 ? Math.sin((rim * Math.PI) / 2) : 0;
      const index = (y * canvas.width + x) * 4;
      pixels.data[index] =
        128 - ((Math.sign(dx) * nx) / (length || 1)) * bend * 112;
      pixels.data[index + 1] = 128 - (dy / (length || 1)) * bend * 112;
      pixels.data[index + 2] = 128;
      pixels.data[index + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL();
}

export function liquidNavigation(node: HTMLElement, selected: string) {
  const mobile = matchMedia("(max-width: 720px)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const lens = node.querySelector<HTMLElement>(".nav-glass-lens");
  let frame = 0;
  let mapSize = "";
  let rebound: Animation | null = null;
  let motionTarget: string | null = null;
  let gesture: {
    id: number;
    x: number;
    y: number;
    dragged: boolean;
    target: HTMLElement;
  } | null = null;
  const buttons = () => [
    ...node.querySelectorAll<HTMLElement>(".nav-link[data-nav-id]"),
  ];
  function active() {
    return buttons().find((button) => button.dataset.navId === selected);
  }
  function place(button: HTMLElement, clientX?: number) {
    const dock = node.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const width = box.width + 4;
    const height = 56;
    const x =
      clientX === undefined
        ? box.left - dock.left - 2
        : Math.max(
            -6,
            Math.min(dock.width - width + 6, clientX - dock.left - width / 2),
          );
    node.style.setProperty("--lens-x", `${x}px`);
    node.style.setProperty("--lens-width", `${width}px`);
    node.style.setProperty("--lens-height", `${height}px`);
    const size = `${Math.round(dock.width)}:${Math.round(width)}:${Math.round(height)}`;
    if (mapSize !== size) {
      mapSize = size;
      node
        .querySelector('[data-glass-map="lens"]')
        ?.setAttribute("href", displacementMap(width, height));
      node
        .querySelector('[data-glass-map="dock"]')
        ?.setAttribute("href", displacementMap(dock.width, 68));
    }
    node.dataset.glassReady = "true";
  }
  function layout() {
    frame = 0;
    if (!mobile.matches || gesture) return;
    const button = active();
    if (button) place(button);
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(layout);
  }
  function finishRebound() {
    rebound?.cancel();
    rebound = null;
    motionTarget = null;
    delete node.dataset.glassSettling;
  }
  function settle(button: HTMLElement) {
    if (!lens || !mobile.matches || reducedMotion.matches) return;
    const scale = getComputedStyle(lens).scale;
    finishRebound();
    motionTarget = button.dataset.navId ?? null;
    node.dataset.glassSettling = "true";
    const animation = lens.animate(
      [
        { scale, offset: 0, easing: "cubic-bezier(.2,.8,.2,1)" },
        { scale: "1.2 1.4", offset: 0.22, easing: "ease-in-out" },
        { scale: ".96 .96", offset: 0.68, easing: "ease-out" },
        { scale: "1.025 1.025", offset: 0.86, easing: "ease-in-out" },
        { scale: "1", offset: 1 },
      ],
      { duration: 560 },
    );
    rebound = animation;
    void animation.finished.then(
      () => {
        if (rebound !== animation) return;
        rebound = null;
        motionTarget = null;
        delete node.dataset.glassSettling;
      },
      () => {},
    );
  }
  function clicked(event: MouseEvent) {
    const button = (event.target as Element).closest<HTMLElement>(
      ".nav-link[data-nav-id]",
    );
    if (button && button.dataset.navId !== selected) settle(button);
  }
  function clearPreview() {
    for (const button of buttons()) delete button.dataset.glassPreview;
    delete node.dataset.glassPress;
    delete node.dataset.glassDrag;
  }
  function stop() {
    gesture = null;
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    clearPreview();
    schedule();
  }
  function cancel() {
    finishRebound();
    stop();
  }
  function move(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.dragged && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx))
      return stop();
    if (!gesture.dragged && Math.abs(dx) < 7) return;
    gesture.dragged = true;
    node.dataset.glassDrag = "true";
    event.preventDefault();
    const candidates = buttons();
    const nearest = candidates.reduce((best, button) => {
      const box = button.getBoundingClientRect();
      const old = best.getBoundingClientRect();
      return Math.abs(event.clientX - box.left - box.width / 2) <
        Math.abs(event.clientX - old.left - old.width / 2)
        ? button
        : best;
    });
    gesture.target = nearest;
    for (const button of candidates)
      button.dataset.glassPreview = String(button === nearest);
    place(nearest, event.clientX);
  }
  function up(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return;
    const { dragged, target } = gesture;
    stop();
    if (dragged) {
      // Suppress the original pressed button's native click after a drag.
      const suppress = (click: MouseEvent) => {
        if (!click.isTrusted) return;
        click.preventDefault();
        click.stopImmediatePropagation();
        node.removeEventListener("click", suppress, true);
      };
      node.addEventListener("click", suppress, { capture: true });
      setTimeout(() => node.removeEventListener("click", suppress, true), 0);
      const dock = node.getBoundingClientRect();
      if (
        event.clientY >= dock.bottom - 92 &&
        event.clientY <= dock.bottom + 24 &&
        target.dataset.navId !== selected
      ) {
        target.focus({ preventScroll: true });
        target.click();
      }
    }
  }
  function down(event: PointerEvent) {
    if (!mobile.matches || !event.isPrimary || event.button !== 0) return;
    const button = (event.target as Element).closest<HTMLElement>(
      ".nav-link[data-nav-id]",
    );
    if (!button || !node.contains(button)) return;
    finishRebound();
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dragged: false,
      target: button,
    };
    node.dataset.glassPress = "true";
    for (const candidate of buttons())
      candidate.dataset.glassPreview = String(candidate === button);
    place(button);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(node);
  const mutations = new MutationObserver(schedule);
  mutations.observe(node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-current"],
  });
  node.addEventListener("pointerdown", down);
  node.addEventListener("click", clicked);
  mobile.addEventListener("change", cancel);
  reducedMotion.addEventListener("change", cancel);
  schedule();
  return {
    update(value: string) {
      const changed = selected !== value;
      selected = value;
      if (changed && motionTarget !== value) {
        const button = active();
        if (button) settle(button);
      }
      schedule();
    },
    destroy() {
      finishRebound();
      stop();
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("click", clicked);
      mobile.removeEventListener("change", cancel);
      reducedMotion.removeEventListener("change", cancel);
    },
  };
}
