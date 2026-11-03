/** Switch native pages without exposing the empty window between their frames. No Electron dependency. */
export function createPagePresentation({ prepare, present, discard, fallback = null, onError = () => {} }) {
  const pages = new Map();
  const retired = new Set();
  let current = null;
  let wanted = null;
  let request = 0;

  function remove(id) {
    const page = pages.get(id);
    pages.delete(id);
    retired.delete(id);
    if (page) discard(id, page.view);
  }
  function ensure(id) {
    let page = pages.get(id);
    if (page) return page;
    const prepared = prepare(id);
    page = { view: prepared.view, loaded: false, ready: null };
    pages.set(id, page);
    page.ready = Promise.resolve(prepared.ready).then(() => { page.loaded = true; }, (error) => {
      if (pages.get(id) === page) remove(id);
      throw error;
    });
    // A preloaded page may never be shown. Its failure must still be handled.
    void page.ready.catch(() => {});
    return page;
  }
  function commit(id, page, ticket) {
    if (ticket !== request || wanted !== id || retired.has(id) || pages.get(id) !== page) return false;
    present(id, page.view);
    current = id;
    for (const old of [...retired]) if (old !== id) remove(old);
    return true;
  }
  function failed(id, ticket, error) {
    // Closing a loading tab destroys its view and rejects loadURL. It is not a failed destination.
    if (ticket !== request || wanted !== id || retired.has(id)) return Promise.resolve(false);
    onError(error);
    if (fallback == null || id === fallback) return Promise.resolve(false);
    return show(fallback).then(() => false);
  }
  function show(id) {
    wanted = id;
    const ticket = ++request;
    let page;
    try { page = ensure(id); } catch (error) { return failed(id, ticket, error); }
    // Already painted background pages switch in this call, without a promise turn.
    if (page.loaded) return Promise.resolve(commit(id, page, ticket));
    return page.ready.then(() => commit(id, page, ticket), (error) => failed(id, ticket, error));
  }
  return {
    currentId: () => current,
    wantedId: () => wanted,
    show,
    warm(id) { return ensure(id).ready.then(() => true, () => false); },
    retire(id) {
      retired.add(id);
      // The outgoing page remains until its replacement is presented.
      if (id !== current) remove(id);
    },
    drop(id) {
      if (id === current || id === wanted) return false;
      remove(id);
      return true;
    },
  };
}

/** Load first, then allow two paint frames; neither a hung navigation nor a throttled frame waits forever. */
export async function preparePage(contents, url, { loadTimeoutMs = 15_000, paintTimeoutMs = 500 } = {}) {
  let timer;
  try {
    await Promise.race([
      contents.loadURL(url),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Page loading timed out'));
          if (!contents.isDestroyed()) contents.stop();
        }, loadTimeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
  if (contents.isDestroyed()) throw new Error('Page closed while loading');
  try {
    await Promise.race([
      contents.executeJavaScript(`(${waitForPageFrame.toString()})(${paintTimeoutMs})`),
      // Also bound the host-side wait if the renderer stops responding before it can run its timer.
      new Promise((resolve) => { timer = setTimeout(resolve, paintTimeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
  if (contents.isDestroyed()) throw new Error('Page closed while painting');
}

/** Runs inside the loaded page. A hidden/throttled renderer may not produce animation frames. */
export function waitForPageFrame(timeoutMs) {
  return new Promise((resolve) => {
    let frame;
    const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
  });
}

/** Show and raise the replacement before hiding any previously visible page. */
export function revealPage(parent, target, pages) {
  target.setVisible(true);
  parent.addChildView(target);
  for (const page of pages) if (page !== target) page.setVisible(false);
  target.webContents.focus();
}
