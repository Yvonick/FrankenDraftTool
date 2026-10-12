(() => {
  const layouts = new Map();
  const gap = 16;

  function groupColumns(width, minimum) {
    return Math.max(1, Math.floor((width + gap) / (minimum + gap)));
  }

  function packGroups(groups, columns) {
    let position = 0;
    for (const group of groups) {
      const heading = group.querySelector(':scope > h4');
      const cards = [...group.querySelector(':scope > .item-stack').children];
      const continuations = [...group.querySelectorAll(':scope > .group-continuation')];
      let segment = 0;
      for (let offset = 0; offset < cards.length;) {
        const column = position % columns;
        const row = Math.floor(position / columns);
        const count = Math.min(columns - column, cards.length - offset);
        let title = segment === 0 ? heading : continuations[segment - 1];
        if (!title) {
          title = document.createElement('h4');
          title.className = 'group-continuation';
          title.setAttribute('aria-hidden', 'true');
          group.append(title);
        }
        if (title !== heading && title.textContent !== heading.textContent) title.textContent = heading.textContent;
        title.style.setProperty('--packed-column', `${column + 1} / span ${count}`);
        title.style.setProperty('--packed-row', row * 2 + 1);
        title.style.setProperty('--heading-gap', row ? '1rem' : '0px');
        for (let index = 0; index < count; index++) {
          const card = cards[offset + index];
          card.style.setProperty('--packed-column', column + index + 1);
          card.style.setProperty('--packed-row', row * 2 + 2);
        }
        offset += count;
        position += count;
        segment++;
      }
      for (const title of continuations.slice(Math.max(0, segment - 1))) title.remove();
    }
  }

  function layout(container) {
    if (!container.clientWidth) return;
    const minimum = window.innerWidth <= 500 ? 140 : 168;
    const columns = groupColumns(container.clientWidth, minimum);
    container.style.setProperty('--layout-columns', columns);
    const groups = [...container.children].filter(child => child.classList.contains('group-section'));
    // Flow cards, not whole categories, through the shared grid. Keep their DOM
    // parents intact so resizing never interrupts selection, focus or previews.
    const packed = groups.length > 0 && groups.every(group => {
      const stack = group.querySelector(':scope > .item-stack');
      return group.querySelector(':scope > h4') && stack?.children.length
        && [...stack.children].every(child => child.classList.contains('item-card'));
    });
    container.classList.toggle('packed-groups', packed);
    if (packed) {
      packGroups(groups, columns);
      return;
    }
    for (const group of groups) {
      for (const title of group.querySelectorAll(':scope > .group-continuation')) title.remove();
      const span = Math.min(columns, Number(group.style.getPropertyValue('--group-columns')) || 1);
      group.style.setProperty('--group-span', span);
      for (const nested of group.querySelectorAll('.group-section')) {
        nested.style.setProperty('--group-span', Math.min(span, Number(nested.style.getPropertyValue('--group-columns')) || 1));
      }
    }
  }

  function refresh() {
    for (const [container, record] of layouts) {
      if (!container.isConnected) {
        record.observer.disconnect();
        layouts.delete(container);
      }
    }
    for (const container of document.querySelectorAll('.item-grid')) {
      let record = layouts.get(container);
      if (!record) {
        const observer = new ResizeObserver(() => layout(container));
        record = { observer, children: new Set() };
        layouts.set(container, record);
        observer.observe(container);
        container.classList.add('compact-groups');
      }
      const groups = [...container.children].filter(child => child.classList.contains('group-section'));
      for (const child of record.children) if (!groups.includes(child)) record.observer.unobserve(child);
      for (const group of groups) if (!record.children.has(group)) record.observer.observe(group);
      record.children = new Set(groups);
      layout(container);
    }
  }

  const root = document.querySelector('#room-view');
  if (!root || typeof ResizeObserver === 'undefined') return;
  const mutations = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
      node.nodeType === 1 && (node.matches('.item-grid, .group-section') || node.querySelector('.item-grid, .group-section'))
    ))) refresh();
  });
  mutations.observe(root, { childList: true, subtree: true });
  refresh();
  window.addEventListener('pagehide', () => {
    mutations.disconnect();
    for (const record of layouts.values()) record.observer.disconnect();
    layouts.clear();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    mutations.observe(root, { childList: true, subtree: true });
    refresh();
  });
})();
