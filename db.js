/**
 * db.js — IndexedDB wrapper for local-first game state persistence
 *
 * Architecture: All game state is written locally first, before any
 * network sync. This ensures the app works fully offline.
 *
 * Schema:
 *   - "games"  store: { roomId, board, moves, currentPlayer, status, deviceId }
 *   - "moves"  store: { id, roomId, cell, player, timestamp, deviceId }
 */

const DB_NAME    = 'tictac-local';
const DB_VERSION = 1;

let _db = null; // cached connection

/**
 * Open (or upgrade) the IndexedDB database.
 * Returns a Promise<IDBDatabase>.
 */
function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Called when version changes or first open — set up object stores
    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Game state store — keyed by roomId
      if (!db.objectStoreNames.contains('games')) {
        db.createObjectStore('games', { keyPath: 'roomId' });
      }

      // Individual moves store — for CRDT-style merge
      if (!db.objectStoreNames.contains('moves')) {
        const moveStore = db.createObjectStore('moves', { keyPath: 'id' });
        moveStore.createIndex('by_room', 'roomId', { unique: false });
      }
    };

    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Generic IDB transaction helper.
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {Function} callback  receives the objectStore, returns a Promise
 */
async function withStore(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;

    try {
      result = callback(store);
    } catch (err) {
      reject(err);
      return;
    }

    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror    = (e) => reject(e.target.error);
  });
}

/** Promisify a single IDBRequest */
function idbReq(req) {
  return new Promise((res, rej) => {
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
}

/* ── PUBLIC API ─────────────────────────────────────────────────── */

/**
 * Save or update a game record.
 * @param {Object} game
 */
async function saveGame(game) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('games', 'readwrite');
    const store = tx.objectStore('games');
    const req   = store.put(game);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
    tx.onerror    = (e) => reject(e.target.error);
  });
}

/**
 * Load a game record by roomId.
 * @param {string} roomId
 * @returns {Promise<Object|null>}
 */
async function loadGame(roomId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('games', 'readonly');
    const store = tx.objectStore('games');
    const req   = store.get(roomId);
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Append a move record (used for CRDT replay / conflict resolution).
 * @param {Object} move  { id, roomId, cell, player, timestamp, deviceId }
 */
async function saveMove(move) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('moves', 'readwrite');
    const store = tx.objectStore('moves');
    const req   = store.put(move); // put = upsert (idempotent)
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
    tx.onerror    = (e) => reject(e.target.error);
  });
}

/**
 * Load all moves for a given room, ordered by timestamp ascending.
 * @param {string} roomId
 * @returns {Promise<Array>}
 */
async function loadMoves(roomId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction('moves', 'readonly');
    const store   = tx.objectStore('moves');
    const index   = store.index('by_room');
    const req     = index.getAll(roomId);
    req.onsuccess = (e) => {
      const moves = (e.target.result || [])
        .sort((a, b) => a.timestamp - b.timestamp);
      resolve(moves);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Delete all data for a room (used on restart / leave).
 * @param {string} roomId
 */
async function clearRoom(roomId) {
  const db = await openDB();

  // Clear game record
  await new Promise((resolve, reject) => {
    const tx    = db.transaction('games', 'readwrite');
    const store = tx.objectStore('games');
    const req   = store.delete(roomId);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });

  // Clear all moves for this room
  await new Promise((resolve, reject) => {
    const tx    = db.transaction('moves', 'readwrite');
    const store = tx.objectStore('moves');
    const index = store.index('by_room');
    const req   = index.openCursor(IDBKeyRange.only(roomId));

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };

    req.onerror = (e) => reject(e.target.error);
  });
}

// Export as module-like globals (no bundler needed)
window.TicTacDB = { saveGame, loadGame, saveMove, loadMoves, clearRoom };
