// receiptStorage.js — Almacenamiento de recibos en IndexedDB (RECEIPT VISION).
// Persiste la imagen del recibo fuera de localStorage (que es texto y pequeño):
// compresión client-side → JPEG ≤1600px q0.8 → blob en IDB → receiptId referenciado
// por la transacción. Fallback si IDB no está disponible: retorna null y la UI
// muestra "Recibo no disponible" sin romper la edición.
//
// NOTA: el hook useReceiptImage se declara en receiptHook.js para no forzar que
// este módulo (que se importa desde servicios puros) arrastre React.

const DB_NAME = "misfinanzas_receipts";
const DB_VERSION = 1;
const STORE_NAME = "images";
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;
export const MAX_RECEIPTS = 500;
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
const ORPHAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function idbAvailable() {
  return typeof indexedDB !== "undefined";
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) return reject(new Error("IndexedDB no disponible"));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("transactionId", "transactionId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
  });
}

function withStore(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const result = fn(store);
        const settle = () => resolve(result);
        tx.oncomplete = settle;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

/** Comprime la imagen a JPEG (máx 1600px, calidad 0.8). */
export function compressImage(blob) {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      return reject(new Error("Canvas no disponible"));
    }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > MAX_EDGE || height > MAX_EDGE) {
        const ratio = Math.min(MAX_EDGE / width, MAX_EDGE / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Contexto 2D no disponible"));
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error("No se pudo comprimir"))),
        "image/jpeg",
        JPEG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo cargar la imagen"));
    };
    img.src = url;
  });
}

export function genReceiptId() {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Guarda un recibo. Devuelve el receiptId o null si falla. */
export async function storeReceipt(blob, transactionId) {
  if (!idbAvailable() || !blob) return null;
  try {
    const compressed = await compressImage(blob);
    const id = genReceiptId();
    const record = {
      id,
      transactionId: transactionId ?? null,
      blob: compressed,
      size: compressed.size,
      createdAt: Date.now(),
    };
    await withStore("readwrite", (store) => store.put(record));
    await enforceLimits();
    return id;
  } catch (err) {
    console.error("[ReceiptStorage] store:", err);
    return null;
  }
}

/** Recupera el blob de un recibo. */
export async function loadReceipt(receiptId) {
  if (!idbAvailable() || !receiptId) return null;
  try {
    const record = await withStore("readonly", (store) => store.get(receiptId));
    return record?.blob || null;
  } catch (err) {
    console.error("[ReceiptStorage] load:", err);
    return null;
  }
}

/** Elimina un recibo. */
export async function deleteReceipt(receiptId) {
  if (!idbAvailable() || !receiptId) return false;
  try {
    await withStore("readwrite", (store) => store.delete(receiptId));
    return true;
  } catch (err) {
    console.error("[ReceiptStorage] delete:", err);
    return false;
  }
}

/** Re-asigna el transactionId de un recibo (tras swap atómico de transferencia). */
export async function updateReceiptTransactionId(receiptId, transactionId) {
  if (!idbAvailable() || !receiptId) return false;
  try {
    await withStore("readwrite", async (store) => {
      const record = await store.get(receiptId);
      if (!record) return;
      record.transactionId = transactionId;
      store.put(record);
    });
    return true;
  } catch (err) {
    console.error("[ReceiptStorage] updateTxId:", err);
    return false;
  }
}

/**
 * Elimina recibos huérfanos (sin transacción válida, con más de 30 días).
 * Se invoca tras borrar transacciones.
 */
export async function cleanupOrphanReceipts(validTransactionIds, now = Date.now()) {
  if (!idbAvailable()) return 0;
  try {
    const valid = new Set(validTransactionIds || []);
    const all = await withStore("readonly", (store) => store.getAll());
    let deleted = 0;
    for (const r of all) {
      const orphaned = !r.transactionId || !valid.has(r.transactionId);
      const old = now - (r.createdAt || 0) > ORPHAN_MAX_AGE_MS;
      if (orphaned && old) {
        await withStore("readwrite", (store) => store.delete(r.id));
        deleted++;
      }
    }
    if (deleted > 0) console.log(`[ReceiptStorage] Limpiados ${deleted} recibos huérfanos`);
    return deleted;
  } catch (err) {
    console.error("[ReceiptStorage] cleanup:", err);
    return 0;
  }
}

/** Aplica límites (500 recibos / 500 MB), eliminando los más antiguos. */
async function enforceLimits() {
  if (!idbAvailable()) return;
  try {
    const all = await withStore("readonly", (store) => store.getAll());
    if (all.length <= MAX_RECEIPTS) {
      const total = all.reduce((s, r) => s + (r.size || 0), 0);
      if (total <= MAX_TOTAL_BYTES) return;
    }
    all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    let count = all.length;
    let size = all.reduce((s, r) => s + (r.size || 0), 0);
    const doomed = [];
    for (const r of all) {
      if (count <= MAX_RECEIPTS && size <= MAX_TOTAL_BYTES) break;
      doomed.push(r.id);
      count--;
      size -= r.size || 0;
    }
    for (const id of doomed) {
      await withStore("readwrite", (store) => store.delete(id));
    }
    if (doomed.length) console.log(`[ReceiptStorage] Límite: eliminados ${doomed.length}`);
  } catch (err) {
    console.error("[ReceiptStorage] enforceLimits:", err);
  }
}