// pdf-receipts.mjs — W39: pipeline de PDFs multi-página para el bot de Telegram.
// CORRER EN EL VPS: node scripts/pdf-receipts.mjs /ruta/archivo.pdf [--dry] [--max-pages N]
//
// Pipeline (reutiliza TODO lo existente):
//   1. pdftoppm (poppler-utils) → PNG por página
//   2. Si el PDF tiene capa de texto (pdftotext) → parseOcrText directo (rápido)
//   3. Si es escaneado → PaddleOCR (127.0.0.1:8765, paddle-ocr.service) por página
//   4. parseOcrText → transacciones
//   5. pushDelta → POST /api/push (protocolo W25/W28 — el server consolida)
//
// Diseñado para que el Hermes Agent lo invoque por terminal:
//   node ~/mis-finanzas/scripts/pdf-receipts.mjs <pdf> [--dry]
// Output final: JSON con {ok, pages, transactions, source} — parseable por el agente.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseOcrText } from "../server/hermes/local.mjs";
import { ocrImage } from "../server/hermes/ocr.mjs";
import { loadProcessorConfig, openDb } from "../server/hermes/processor.mjs";
import * as apply from "../server/hermes/apply.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const CONFIG_PATH = process.env.HERMES_CONFIG || path.join(REPO, "server/hermes/config.json");

const args = process.argv.slice(2);
const pdfPath = args.find((a) => !a.startsWith("--"));
const DRY = args.includes("--dry");
const MAX_PAGES = Number(args[args.indexOf("--max-pages") + 1]) || 24;
const ACCOUNT = args[args.indexOf("--account") + 1] || null;

const log = (m) => console.error(`[pdf-receipts] ${new Date().toISOString().slice(11, 19)} ${m}`);

if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error(JSON.stringify({ ok: false, error: `PDF no encontrado: ${pdfPath || "(falta argumento)"}` }));
  process.exit(1);
}

const cfg = loadProcessorConfig(CONFIG_PATH);
const OCR_URL = process.env.OCR_URL || cfg.ocrUrl || "http://127.0.0.1:8765";
const OCR_TIMEOUT = 300_000; // páginas grandes tardan; el clamp de ocr.mjs lo sube vía OCR_TIMEOUT_MAX
process.env.OCR_TIMEOUT_MAX = "300000";

// ── helpers ──
const run = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", timeout: opts.timeout || 120_000, stdio: ["ignore", "pipe", "pipe"] });

function renderPages(pdf, outPrefix, pages) {
  // W39-fix: renderizar SOLO las páginas necesarias (-f 1 -l N) — antes pdftoppm
  // renderizaba las 24 páginas (3m46s) aunque solo se pidieran 2.
  // 100 dpi: las páginas (925x2682pts) quedan <4000px (el max_side_limit de Paddle)
  const range = pages ? `-f ${pages[0]} -l ${pages[1]}` : "";
  run(`pdftoppm -png -r 100 ${range} "${pdf}" "${outPrefix}"`, { timeout: 10 * 60_000 });
  return fs.readdirSync(path.dirname(outPrefix)).filter((f) => f.startsWith(path.basename(outPrefix)) && f.endsWith(".png")).map((f) => path.join(path.dirname(outPrefix), f)).sort();
}

async function ocrPage(imgPath) {
  return await ocrImage(imgPath, { url: OCR_URL, timeoutMs: OCR_TIMEOUT });
}

// ── main ──
async function main() {
  const t0 = Date.now();
  log(`PDF: ${pdfPath}`);

  // 1. ¿capa de texto? (pdftotext es más rápido que pdfjs para este chequeo)
  let textLayer = "";
  try { textLayer = run(`pdftotext "${pdfPath}" -`).trim(); } catch { /* sin pdftotext */ }

  const results = []; // { page, text, parsed }
  let source = "ocr";

  if (textLayer.length > 200) {
    // PDF con capa de texto → parseo directo (sin OCR, sin render)
    log(`capa de texto detectada (${textLayer.length} chars) → parseo directo`);
    source = "pdf_text";
    const parsed = parseOcrText(textLayer);
    results.push({ page: 1, text: textLayer.slice(0, 500), parsed: parsed?.ok ? parsed.result : null });
  } else {
    // PDF escaneado → render + PaddleOCR por página
    log("sin capa de texto útil → render + PaddleOCR por página");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "w39-pdf-"));
    const outPrefix = path.join(tmpDir, "page");
    log(`renderizando páginas…`);
    let pages = renderPages(pdfPath, outPrefix, [1, MAX_PAGES]);
    if (pages.length > MAX_PAGES) {
      log(`recortando a ${MAX_PAGES} de ${pages.length} páginas`);
      pages = pages.slice(0, MAX_PAGES);
    }
    log(`${pages.length} páginas renderizadas`);

    for (let i = 0; i < pages.length; i++) {
      const img = pages[i];
      log(`OCR página ${i + 1}/${pages.length}: ${path.basename(img)}`);
      try {
        const text = await ocrPage(img);
        const parsed = parseOcrText(text || "");
        results.push({ page: i + 1, text: (text || "").slice(0, 400), parsed: parsed?.ok ? parsed.result : null });
        log(`  página ${i + 1}: ${parsed?.ok ? `parseada (${parsed.result.type})` : "sin formato reconocible"} | ${String(text || "").length} chars`);
      } catch (e) {
        log(`  página ${i + 1}: OCR falló — ${String(e?.message || e).slice(0, 100)}`);
        results.push({ page: i + 1, text: "", parsed: null, error: String(e?.message || e).slice(0, 120) });
      }
      fs.unlinkSync(img); // limpiar el PNG grande
    }
    try { fs.rmdirSync(tmpDir); } catch { /* no vacío, ok */ }
  }

  // 3. agregar las transacciones de todas las páginas parseadas
  const txs = [];
  for (const r of results) {
    if (!r.parsed) continue;
    const p = r.parsed;
    if (p.type === "receipt" && p.total > 0) {
      txs.push({ description: p.merchant || "Recibo", amount: -Math.abs(p.total), date: p.date || null, category: p.items?.[0]?.category || null });
    } else if (p.type === "statement") {
      for (const m of p.movements || []) txs.push({ description: m.description, amount: m.direction === "in" ? Math.abs(m.amount) : -Math.abs(m.amount), date: m.date || null, category: m.category || null });
    } else if (p.type === "transfer" && p.transfer) {
      txs.push({ description: `Transferencia ${p.transfer.from ? `de ${p.transfer.from}` : ""}${p.transfer.to ? ` a ${p.transfer.to}` : ""}`.trim(), amount: -Math.abs(p.transfer.amount), date: p.date || null, category: null });
    }
  }

  log(`resultado: ${results.filter((r) => r.parsed).length}/${results.length} páginas parseadas | ${txs.length} transacciones`);

  // 4. push vía el protocolo W25/W28 (pushDelta → /api/push → el server consolida)
  let pushRes = null;
  if (txs.length && !DRY) {
    const db = openDb(cfg.dbPath || undefined);
    let state = await apply.loadState(db, cfg.syncCode);
    // asignar accountId: --account <id> | binding.defaultAccountId | la primera
    const defaultAcc = ACCOUNT || cfg.defaultAccountId || (state.accounts?.[0]?.id ?? null);
    if (!ACCOUNT) log(`⚠️ sin --account: usando ${defaultAcc} (${(state.accounts?.find(a => a.id === defaultAcc) || {}).name || "?"})`);
    // Usar apply.addTransaction para generar IDs, _createdAt, _updatedAt, category guard, balance update
    for (const t of txs) {
      state = apply.addTransaction(state, { ...t, accountId: defaultAcc });
    }
    const delta = {
      accounts: state.accounts,
      transactions: state.transactions,
      _syncVersion: state._syncVersion,
    };
    try {
      pushRes = await apply.pushDelta(cfg, delta);
      log(`push OK: v${pushRes.syncVersion} (${txs.length} txs)`);
    } catch (e) {
      log(`push FALLÓ: ${e.message}`);
    }
    db.close?.();
  } else if (DRY) {
    log(`dry-run: ${txs.length} transacciones detectadas (sin push)`);
  }

  // 5. output JSON para el agente (stderr = logs, stdout = el resultado final)
  console.log(JSON.stringify({
    ok: true,
    pdf: path.basename(pdfPath),
    pages: results.length,
    pagesParsed: results.filter((r) => r.parsed).length,
    source,
    transactions: txs,
    pushed: pushRes ? { ok: true, syncVersion: pushRes.syncVersion } : { ok: false, dry: DRY || !txs.length },
    pagesDetail: results.map((r) => ({ page: r.page, type: r.parsed?.type || null, merchant: r.parsed?.merchant || null, total: r.parsed?.total || null, chars: (r.text || "").length })),
    ms: Date.now() - t0,
  }));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 300) }));
  process.exit(1);
});