// Private extension-origin storage for the current blog gallery only.
// No network requests, settings quota usage or additional permissions.
(() => {
  const DB_NAME = "DdalkkakBlogGalleryV1";
  const STORE = "gallery";
  let opening = null;
  let queue = Promise.resolve();
  let lastCommitted = null;

  function copyImages(images) {
    return Array.isArray(images) ? images.map(image => image && typeof image === "object"
      && typeof image.dataUrl === "string" && image.dataUrl.startsWith("data:image/")
      ? { ...image } : null) : [];
  }

  function equalSnapshot(left, right) {
    return left?.draftId === right.draftId && left.images.length === right.images.length
      && left.images.every((image, index) => {
        const next = right.images[index];
        if (!image || !next) return image === next;
        const keys = Object.keys(image);
        return keys.length === Object.keys(next).length && keys.every(key => image[key] === next[key]);
      });
  }

  function openDB() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error("Image storage is unavailable.")); return; }
      let request;
      try { request = indexedDB.open(DB_NAME, 1); } catch (error) { reject(error); return; }
      let failed = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onerror = () => { failed = true; reject(request.error || new Error("Image storage could not be opened.")); };
      request.onblocked = () => { failed = true; reject(new Error("Image storage is busy.")); };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = null; lastCommitted = null; };
        resolve(db);
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  }

  async function transaction(mode, action) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      let tx;
      let value = null;
      try {
        tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        request.onsuccess = () => { value = request.result; };
      } catch (error) { reject(error); return; }
      // A successful put request can still be followed by a failed commit.
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Image storage transaction failed."));
    });
  }

  function save(draftId, images) {
    const snapshot = { schemaVersion: 1, draftId: String(draftId || ""), images: copyImages(images) };
    if (!snapshot.draftId) snapshot.images = [];
    const task = queue.catch(() => {}).then(async () => {
      if (equalSnapshot(lastCommitted, snapshot)) return;
      await transaction("readwrite", store => store.put(snapshot, "current"));
      lastCommitted = snapshot;
    });
    queue = task;
    return task;
  }

  async function load(draftId) {
    await queue.catch(() => {});
    if (!draftId) return [];
    const record = await transaction("readonly", store => store.get("current"));
    if (record?.schemaVersion !== 1 || record.draftId !== draftId) return [];
    const images = copyImages(record.images);
    lastCommitted = { ...record, images };
    return copyImages(images);
  }

  globalThis.ddalkkakBlogImageStore = Object.freeze({ save, load });
})();
