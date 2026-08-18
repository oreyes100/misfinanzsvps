// photoScanner.js — Escaneo progresivo de Google Photos en busca de recibos,
// estados de cuenta y comprobantes de transferencia.
//
// - Paginado (100/página) reanudable por nextPageToken.
// - Filtro barato por nombre de archivo ANTES de OCR (solo se analizan
//   candidatos plausibles).
// - Presupuesto de tiempo y topes por ejecución (maxItems / maxCandidates).
// - El analizador OCR se inyecta (`analyze`) para poder testear sin tesseract.
// - `buildQueueItems` convierte un resultado en items de la Review Queue MCP.

import { classifyConfidence } from "../review.js";
import { todayISO, uid } from "../utils.js";
import { detectReceipt, receiptFileNameHint } from "./receiptDetector.js";

export const PHOTOS_API = "https://photoslibrary.googleapis.com/v1";
export const PAGE_SIZE = 100;

/** URL de descarga con ancho máx. fijo (evita bajarse el original completo). */
export function buildMediaUrl(baseUrl, size = 2048) {
  return baseUrl ? `${baseUrl}=w${size}` : null;
}

/** URL de miniatura cuadrada para la cuadrícula del selector. */
export function thumbnailUrl(baseUrl, size = 400) {
  return baseUrl ? `${baseUrl}=w${size}-h${size}-c` : null;
}

/**
 * Lista media items de la librería (o de un álbum). Devuelve
 * { items, nextPageToken }.
 */
export async function listMediaItems(accessToken, { albumId, pageSize = PAGE_SIZE, pageToken, signal } = {}) {
  const endpoint = albumId ? `albums/${encodeURIComponent(albumId)}/mediaItems` : "mediaItems";
  const url = new URL(`${PHOTOS_API}/${endpoint}`);
  url.searchParams.set("pageSize", String(pageSize));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Google Photos ${r.status}: ${body.slice(0, 140)}`);
  }
  const data = await r.json();
  return { items: data.mediaItems || [], nextPageToken: data.nextPageToken || null };
}

/**
 * Analiza UNA media item: descarga (≤maxSize), OCR y normalización a un shape
 * común: { kind, detection, merchant, total, date, category, movements, transfer, text }.
 * Devuelve null si no se pudo analizar o no parece documento financiero.
 */
export async function analyzeMediaItem(mediaItem, deps) {
  const { ocr, categories, accounts, categoryAliases = {}, statementPatterns = {}, transferAliases = {}, maxSize = 1600 } = deps;
  if (!mediaItem?.baseUrl) return null;
  const url = buildMediaUrl(mediaItem.baseUrl, maxSize);
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  const text = await ocr(blob);
  if (!text || text.trim().length < 8) return null;
  const detection = detectReceipt(text, mediaItem.filename || "");
  const kind = detection.kind;
  if (!kind) return null;

  if (kind === "receipt") {
    const p = await deps.parseReceipt(text, categories, categoryAliases);
    const top = Array.isArray(p.groups) ? p.groups[0] : null;
    return { kind, detection, text, merchant: p.merchant, total: p.total, date: p.date, category: top?.category || null, items: p.items };
  }
  if (kind === "statement") {
    const p = await deps.parseStatement(text, { statementPatterns, accounts });
    return { kind, detection, text, merchant: p.merchant, movements: p.movements };
  }
  const p = await deps.parseTransfer(text, accounts, transferAliases);
  return { kind, detection, text, transfer: { amount: p.amount, from: p.from, to: p.to }, merchant: p.from?.name || p.to?.name || "Transferencia" };
}

/**
 * Escaneo progresivo. Recorre páginas hasta topes o agotar tiempo.
 *
 * @param {string} accessToken — token de acceso Google Photos
 * @param {Object} opts
 *   - albumId?: string — álbum concreto o null (librería completa)
 *   - pageToken?: string — reanudar desde una página previa
 *   - analyze?: fn(mediaItem) => análisis normalizado | null
 *   - onResult?: fn(result, scanned, candidates)
 *   - onProgress?: fn(scanned, candidates)
 *   - signal?: AbortSignal
 *   - maxItems / maxCandidates / timeBudgetMs
 * @returns {Promise<{results, scanned, candidates, nextPageToken, done}>}
 */
export async function scanForReceipts(accessToken, opts = {}) {
  const {
    albumId, pageToken, analyze, onResult, onProgress, signal,
    maxItems = 60, maxCandidates = 12, timeBudgetMs = 60_000,
  } = opts;
  const t0 = Date.now();
  let next = pageToken || null;
  let scanned = 0;
  let candidates = 0;
  const results = [];

  for (;;) {
    if (signal?.aborted) throw new DOMException("Escaneo cancelado.", "AbortError");
    if (Date.now() - t0 > timeBudgetMs) break;
    if (scanned >= maxItems) break;
    const { items, nextPageToken } = await listMediaItems(accessToken, { albumId, pageToken: next, signal });
    if (!items.length) break;
    for (const item of items) {
      if (scanned >= maxItems) break;
      scanned++;
      onProgress?.(scanned, candidates);
      // Filtro barato: nombre de archivo debe sugerir documento antes de OCR.
      if (!receiptFileNameHint(item.filename || "")) continue;
      if (candidates >= maxCandidates) break;
      candidates++;
      const analysis = analyze ? await analyze(item) : null;
      const result = {
        item,
        analysis,
        detection: analysis?.detection || detectReceipt("", item.filename || ""),
      };
      results.push(result);
      onResult?.(result, scanned, candidates);
    }
    next = nextPageToken;
    if (!next) break;
  }
  const done = !next || scanned >= maxItems || candidates >= maxCandidates;
  return { results, scanned, candidates, nextPageToken: next, done };
}

/**
 * Convierte el resultado de un análisis en items de la Review Queue MCP
 * (mismo shape que Assistant: action + preview). Puro y testeable.
 */
export function buildQueueItems(result, { accounts, baseCurrency = "EUR" } = {}) {
  const analysis = result?.analysis;
  if (!analysis?.kind) return [];
  const acc = Array.isArray(accounts) ? accounts[0] : null;
  const currency = acc?.currency || baseCurrency;
  const confidence = analysis.detection?.confidence ?? 0.5;
  const classification = classifyConfidence(confidence);
  const batchId = uid();
  const items = [];

  const push = (fields) =>
    items.push({
      id: uid(),
      batchId,
      source: "ocr",
      classification,
      confidence,
      createdAt: Date.now(),
      // RECEIPT VISION: referencia al media item original para validar visualmente.
      ...(result?.item?.baseUrl ? { receiptUrl: thumbnailUrl(result.item.baseUrl, 800) } : {}),
      ...fields,
    });

  if (analysis.kind === "receipt") {
    const total = analysis.total;
    if (total == null || !(total > 0)) return [];
    const amount = -Math.round(total * 100) / 100;
    push({
      action: {
        type: "add_transaction",
        tx: {
          description: analysis.merchant || "Recibo",
          amount,
          currency,
          accountId: acc?.id,
          category: analysis.category || undefined,
          date: analysis.date || todayISO(),
          auto: true,
        },
      },
      preview: {
        description: analysis.merchant || "Recibo",
        amount,
        currency,
        date: analysis.date || todayISO(),
        category: analysis.category || null,
        categoryId: null,
        accountId: acc?.id || null,
        accountName: acc?.name || null,
        subcategory: null,
      },
    });
  } else if (analysis.kind === "statement") {
    for (const m of (analysis.movements || []).slice(0, 40)) {
      const signed = m.direction === "in" ? m.amount : -m.amount;
      if (!(signed > 0) && !(signed < 0)) continue;
      push({
        action: {
          type: "add_transaction",
          tx: {
            description: m.description || "Movimiento",
            amount: Math.round(signed * 100) / 100,
            currency,
            accountId: acc?.id,
            category: m.category || undefined,
            date: m.date || todayISO(),
            auto: true,
          },
        },
        preview: {
          description: m.description || "Movimiento",
          amount: Math.round(signed * 100) / 100,
          currency,
          date: m.date || todayISO(),
          category: m.category || null,
          categoryId: null,
          accountId: acc?.id || null,
          accountName: acc?.name || null,
          subcategory: null,
        },
      });
    }
  } else if (analysis.kind === "transfer") {
    const t = analysis.transfer;
    if (!t?.amount || !t.from?.id || !t.to?.id || t.from.id === t.to.id) return [];
    push({
      action: { type: "transfer", fromId: t.from.id, toId: t.to.id, amount: Math.round(t.amount * 100) / 100 },
      preview: {
        description: `Transferencia ${t.from.name} → ${t.to.name}`,
        amount: -Math.round(t.amount * 100) / 100,
        currency: t.from.currency || currency,
        date: todayISO(),
        category: "Transferencia",
        categoryId: null,
        accountId: t.from.id,
        accountName: t.from.name,
        subcategory: null,
      },
    });
  }

  return items;
}