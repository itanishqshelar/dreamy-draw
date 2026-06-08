const DB_NAME = "dreamydraw-db";
const DB_VERSION = 1;
const STORE = "sessions";

function openDreamyDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, callback) {
  const db = await openDreamyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = callback(store);

    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

window.DreamyDB = {
  async listSessions() {
    const db = await openDreamyDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        db.close();
        resolve(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  },

  async getSession(id) {
    const db = await openDreamyDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const request = store.get(id);

      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        reject(request.error);
      };
    });
  },

  saveSession(session) {
    return withStore("readwrite", (store) => store.put(session));
  },

  deleteSession(id) {
    return withStore("readwrite", (store) => store.delete(id));
  },

  async exportAll() {
    return {
      app: "dreamydraw",
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: await this.listSessions()
    };
  }
};
