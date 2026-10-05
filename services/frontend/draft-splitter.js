(() => {
  const layout = document.querySelector('#bag-draft-layout');
  const divider = document.querySelector('#bag-divider');
  const picks = document.querySelector('#bag-picks-panel');
  if (!layout || !divider || !picks) return;
  const storageKey = 'franken-draft:picks-width';
  const desktop = window.matchMedia('(min-width: 801px)');
  const defaultShare = 37;
  let share = defaultShare;
  let drag = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved >= 25 && saved <= 75) share = saved;
  } catch { /* Local preferences are optional. */ }

  function limits() {
    const gap = parseFloat(getComputedStyle(layout).columnGap) || 0;
    const available = layout.clientWidth - divider.offsetWidth - gap * 2;
    const minimum = Math.min(50, Math.max(25, 240 / Math.max(1, available) * 100));
    return { available, min: minimum, max: 100 - minimum };
  }

  function apply() {
    if (!desktop.matches || !layout.clientWidth) return;
    const { min, max } = limits();
    const value = Math.max(min, Math.min(max, share));
    layout.style.setProperty('--bag-width', `${100 - value}fr`);
    layout.style.setProperty('--picks-width', `${value}fr`);
    divider.setAttribute('aria-valuemin', String(Math.round(min)));
    divider.setAttribute('aria-valuemax', String(Math.round(max)));
    divider.setAttribute('aria-valuenow', String(Math.round(value)));
    divider.setAttribute('aria-valuetext', `Your Picks: ${Math.round(value)}%`);
  }

  function save() {
    try { localStorage.setItem(storageKey, String(share)); } catch { /* Keep the current session usable. */ }
  }

  function finish(cancelled = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancelled) share = previous.share;
    divider.classList.remove('dragging');
    document.body.classList.remove('resizing-draft');
    if (divider.hasPointerCapture(previous.id)) divider.releasePointerCapture(previous.id);
    apply();
    if (!cancelled) save();
  }

  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !desktop.matches || drag) return;
    event.preventDefault();
    divider.focus();
    drag = { id: event.pointerId, x: event.clientX, width: picks.getBoundingClientRect().width, share };
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('resizing-draft');
  });
  divider.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const { available, min, max } = limits();
    share = Math.max(min, Math.min(max, (drag.width - event.clientX + drag.x) / available * 100));
    apply();
  });
  divider.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) finish(); });
  divider.addEventListener('pointercancel', () => finish(true));
  divider.addEventListener('lostpointercapture', () => finish(true));
  divider.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); return; }
    if (!desktop.matches || drag || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = limits();
    const current = Math.max(min, Math.min(max, share));
    share = event.key === 'Enter' ? defaultShare : event.key === 'Home' ? min : event.key === 'End' ? max
      : current + (event.key === 'ArrowLeft' ? 2 : -2);
    share = Math.max(min, Math.min(max, share));
    apply(); save();
  });
  divider.addEventListener('dblclick', () => { share = defaultShare; apply(); save(); });
  desktop.addEventListener('change', () => { finish(true); apply(); });
  window.addEventListener('pagehide', () => finish(true));
  const observer = new ResizeObserver(apply);
  observer.observe(layout);
  apply();
})();
