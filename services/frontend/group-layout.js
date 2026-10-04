(() => {
  const layouts = new Map();
  const rowHeight = 4;
  const gap = 16;

  function groupColumns(width, minimum) {
    return Math.max(1, Math.floor((width + gap) / (minimum + gap)));
  }

  function layout(container) {
    if (!container.clientWidth) return;
    const minimum = window.innerWidth <= 500 ? 140 : 168;
    const columns = groupColumns(container.clientWidth, minimum);
    container.style.setProperty('--layout-columns', columns);
    const groups = [...container.children].filter(child => child.classList.contains('group-section'));
    for (const group of groups) {
      const span = Math.min(columns, Number(group.style.getPropertyValue('--group-columns')) || 1);
      group.style.setProperty('--group-span', span);
      for (const nested of group.querySelectorAll('.group-section')) {
        nested.style.setProperty('--group-span', Math.min(span, Number(nested.style.getPropertyValue('--group-columns')) || 1));
      }
    }
    // Natural group heights are independent of row spans. Image loads can change
    // heights without replacing cards, stealing focus, or clearing selections.
    for (const group of groups) {
      group.style.gridRowEnd = `span ${Math.max(1, Math.ceil((group.getBoundingClientRect().height + gap) / rowHeight))}`;
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
