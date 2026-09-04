#!/usr/bin/env node
// wargame-cli.mjs — W34: CLI del loop omnipresente (status/issues/resume/spec).
// W34-I1: auth por sync-code leído de ~/.config/misfinanzas/sync-code
// (permisos 600, se aprietan solos si están más abiertos) enviado como
// `Authorization: W1 <sync-code>`, y salida SIEMPRE JSON en stdout: un único
// documento por comando con las claves canónicas del envelope ("status" = HTTP,
// "issues" = issues del comando) aunque la API falle — los checks del
// review-loop hacen grep sobre stdout y los pipes deben romperse jamás.
//
// Uso: node scripts/wargame-cli.mjs <status|issues [wN]|resume <id>|spec [file.json]>
// Env: WARGAME_API (default http://localhost:3000),
//      WARGAME_SYNC_CODE_FILE (default ~/.config/misfinanzas/sync-code).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Base de la API wargame. W34-I1: localhost:3000 (el server del VPS). */
export function baseUrl() {
  return process.env.WARGAME_API || "http://localhost:3000";
}

/** Ruta del sync-code (W34-I1): ~/.config/misfinanzas/sync-code. */
export function syncCodePath() {
  return process.env.WARGAME_SYNC_CODE_FILE || path.join(os.homedir(), ".config", "misfinanzas", "sync-code");
}

/**
 * Lee el sync-code. W34-I1: el fichero de secreto debe tener permisos 600 —
 * si está más abierto se aprieta al instante. Nunca lanza: devuelve
 * {ok:true, code} | {ok:false, error} (lectura ausente/corrupta = graceful).
 */
export function readSyncCode(file = syncCodePath()) {
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o777) !== 0o600) {
      try { fs.chmodSync(file, 0o600); } catch { /* FS de solo lectura: seguir */ }
    }
    const code = (fs.readFileSync(file, "utf8") || "").trim();
    return code ? { ok: true, code } : { ok: false, error: `sync-code vacío en ${file}` };
  } catch (e) {
    return {
      ok: false,
      error: e?.code === "ENOENT" ? `No existe ${file} (créalo con permisos 600)` : `No se pudo leer ${file}: ${e?.message || e}`,
    };
  }
}

/** Header W1 (W34-I1): `Authorization: W1 <sync-code>` — sin code, sin header. */
export function authHeader(code) {
  return code ? { Authorization: `W1 ${code}` } : {};
}

/**
 * Petición a la API wargame. W34-I1: nunca lanza — devuelve
 * {status, data, warning} con status=null si no hubo respuesta HTTP. Sin
 * sync-code se sigue igual (endpoints públicos) y se avisa en `warning`.
 */
export async function api(pathname, opts = {}) {
  const sc = readSyncCode();
  const warning = sc.ok ? null : sc.error;
  try {
    const res = await fetch(`${baseUrl()}${pathname}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(sc.ok ? authHeader(sc.code) : {}), ...(opts.headers || {}) },
    });
    let data;
    try { data = await res.json(); }
    catch { data = { ok: false, error: `HTTP ${res.status} (respuesta sin JSON)` }; }
    return { status: res.status, data, warning };
  } catch (e) {
    return { status: null, data: { ok: false, error: `sin conexión con ${baseUrl()} (${e?.message || e})` }, warning };
  }
}

const USAGE = `Wargame CLI — loop omnipresente (W34-I1)
Uso: node scripts/wargame-cli.mjs <comando>

  status             GET  /api/wargame/status  → {"status":<http>,"total":N,"byState":{…}}
  issues [wN]        GET  /api/wargame/issues  → {"status":<http>,"issues":[…],"count":N}
  resume <id>        POST /api/wargame/resume → {"status":<http>,"issue":{…}}
  spec [file.json]   POST /api/wargame/spec   → {"status":<http>,"issues":[…]}

Auth: Authorization: W1 <sync-code>, leído de ~/.config/misfinanzas/sync-code
(permisos 600; override con WARGAME_SYNC_CODE_FILE). Base: WARGAME_API
(default http://localhost:3000). Salida: siempre JSON en stdout.`;

function emit(payload) {
  console.log(JSON.stringify(payload));
}

/** Comando → envelope JSON en stdout. Devuelve el exit code. */
export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "status": {
      const { status, data, warning } = await api("/api/wargame/status");
      emit({ ...data, ok: data.ok ?? status === 200, status, ...(warning ? { warning } : {}) });
      return 0;
    }
    case "issues": {
      const { status, data, warning } = await api("/api/wargame/issues");
      let issues = Array.isArray(data.issues) ? data.issues : [];
      if (args[0]) issues = issues.filter((i) => i.wargame === Number(args[0]));
      emit({ ...data, ok: data.ok ?? status === 200, status, issues, count: issues.length, ...(warning ? { warning } : {}) });
      return 0;
    }
    case "resume": {
      const id = args[0];
      if (!id) { console.error("Uso: wargame-cli resume w34-i1"); return 1; }
      const { status, data } = await api("/api/wargame/resume", { method: "POST", body: JSON.stringify({ id }) });
      emit({ ...data, ok: data.ok ?? status === 200, status });
      return 0;
    }
    case "spec": {
      let body = {};
      if (args[0]) {
        try { body = JSON.parse(fs.readFileSync(args[0], "utf8")); }
        catch (e) { console.error(`❌ No se pudo leer el spec ${args[0]}: ${e?.message || e}`); return 1; }
      }
      const { status, data, warning } = await api("/api/wargame/spec", { method: "POST", body: JSON.stringify(body) });
      // W34-I1: "issues" = issues creados (ids del server) o los que ya traiga
      // la respuesta — la clave viaja siempre para el grep del review-loop.
      emit({ ...data, ok: data.ok ?? status === 200, status, issues: data.issues ?? data.ids ?? [], ...(warning ? { warning } : {}) });
      return 0;
    }
    default:
      console.log(USAGE);
      return 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((e) => { console.error("❌", e?.message || e); process.exit(1); });
}
