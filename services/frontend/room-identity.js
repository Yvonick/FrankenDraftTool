(() => {
  const prefix = 'frankenDraftTool:room:';
  const fields = ['participantId', 'role', 'name', 'creatorToken'];
  const readJson = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
  const write = (storage, key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch {} };
  function read(room) {
    const key = prefix + room;
    const selector = new URLSearchParams(location.hash?.slice(1) || '').get('player');
    const selected = selector && readJson(localStorage, `${key}:${selector}`);
    const current = readJson(sessionStorage, key);
    if (selected && selected.participantId !== current?.participantId) {
      write(sessionStorage, key, selected); return selected;
    }
    if (current) return current;
    const legacy = {};
    for (const field of fields) {
      const value = sessionStorage.getItem(`room:${room}:${field}`);
      if (value) legacy[field] = value;
    }
    const saved = Object.keys(legacy).length ? { ...legacy, token: sessionStorage.getItem('frankenDraftTool:sessionToken') }
      : readJson(localStorage, key) || {};
    write(sessionStorage, key, saved);
    if (Object.keys(legacy).length) write(localStorage, key, saved);
    return saved;
  }
  window.frankenRoomIdentity = {
    getItem(key) {
      const match = key.match(/^room:(\d{6}):(participantId|role|name|creatorToken)$/);
      return match ? read(match[1])[match[2]] || null : sessionStorage.getItem(key);
    },
    setItem(key, value) {
      const match = key.match(/^room:(\d{6}):(participantId|role|name|creatorToken)$/);
      if (!match) { sessionStorage.setItem(key, value); return; }
      const record = { ...read(match[1]), [match[2]]: String(value) };
      record.token ||= sessionStorage.getItem('frankenDraftTool:sessionToken');
      write(sessionStorage, prefix + match[1], record);
      if (!record.isolated) write(localStorage, prefix + match[1], record);
      if (record.participantId) write(localStorage, `${prefix}${match[1]}:${record.participantId}`, record);
    },
    tokenFor(url, fallback) {
      const room = new URL(url, location.origin).pathname.match(/^\/api\/rooms\/(\d{6})(?:\/|$)/)?.[1];
      return room ? read(room).token || fallback : fallback;
    },
    adopt(room, identity, token, creatorToken) {
      const isolated = Boolean(read(room).isolated);
      this.clear(room);
      const record = { ...identity, token, isolated, ...(creatorToken ? { creatorToken } : {}) };
      write(sessionStorage, prefix + room, record);
      if (!isolated) write(localStorage, prefix + room, record);
      write(localStorage, `${prefix}${room}:${identity.participantId}`, record);
    },
    fork(room) {
      write(sessionStorage, prefix + room, { token: crypto.randomUUID(), isolated: true });
      for (const field of fields) sessionStorage.removeItem(`room:${room}:${field}`);
    },
    isIsolated(room) { return Boolean(read(room).isolated); },
    restoredPath(room) {
      const current = read(room);
      return `/rooms/${room}${current.isolated && current.participantId ? '#player=' + current.participantId : ''}`;
    },
    clear(room) {
      const current = read(room), key = prefix + room;
      const saved = readJson(localStorage, key);
      if (saved?.participantId === current.participantId && saved?.token === current.token) {
        try { localStorage.removeItem(key); } catch {}
      }
      write(sessionStorage, key, {});
      const archived = readJson(localStorage, `${key}:${current.participantId}`);
      if (archived?.token === current.token) {
        try { localStorage.removeItem(`${key}:${current.participantId}`); } catch {}
      }
      for (const field of fields) sessionStorage.removeItem(`room:${room}:${field}`);
    }
  };
})();
