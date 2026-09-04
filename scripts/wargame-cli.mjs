#!/usr/bin/env node
// wargame-cli.mjs — W34: CLI del loop omnipresente (status/issues/resume/spec).
// Uso: node scripts/wargame-cli.mjs <status|issues|resume <id>|spec <file.json>>
// Auth: WARGAME_TOKEN env o ~/.wargame-token (fallback, chmod 600).
// El token = learnToken del hermes config del VPS (o el syncCode como fallback).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.WARGAME_API || "https://dineroorganizado.duckdns.org";
const [,, cmd, ...args] = process.argv;

function token() {
  if (process.env.WARGAME_TOKEN) return process.env.WARGAME_TOKEN;
  try {
    return fs.readFileSync(path.join(os.homedir(), ".wargame-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function api(pathname, opts = {}) {
  const t = token();
  const res = await fetch(`${BASE}${pathname}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
    },
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `HTTP ${res.status} (sin JSON)` };
  }
  return { status: res.status, data };
}

async function main() {
  switch (cmd) {
    case "status": {
      const { status, data } = await api("/api/wargame/status");
      if (status !== 200) return console.error(`❌ HTTP ${status}: ${data.error || "error"}`);
      console.log(`Tablero wargame — ${data.total} issues`);
      for (const [state, n] of Object.entries(data.byState)) console.log(`  ${String(state).padEnd(16)} ${n}`);
      break;
    }
    case "issues": {
      const { status, data } = await api("/api/wargame/issues");
      if (status !== 200) return console.error(`❌ HTTP ${status}: ${data.error || "error"}`);
      const filter = args[0];
      const rows = data.issues.filter((i) => (filter ? i.wargame === Number(filter) : true));
      for (const i of rows) {
        const flag = i.lastError ? ` ⚠️ ${i.lastError.slice(0, 40)}` : "";
        console.log(`${i.id}  ${String(i.state).padEnd(16)} build:${i.buildAttempts} rev:${i.reviewAttempts}  ${i.title.slice(0, 60)}${flag}`);
      }
      break;
    }
    case "resume": {
      const id = args[0];
      if (!id) return console.error("Uso: wargame-cli resume w33-i1");
      const { status, data } = await api("/api/wargame/resume", { method: "POST", body: JSON.stringify({ id }) });
      if (data.ok) console.log(`🔁 ${data.issue.id} → ${data.issue.state}`);
      else console.error(`❌ HTTP ${status}: ${data.error}`);
      break;
    }
    case "spec": {
      const file = args[0];
      if (!file) return console.error("Uso: wargame-cli spec spec.json — JSON {wargame, idea, answers:[7]}");
      const body = JSON.parse(fs.readFileSync(file, "utf8"));
      const { status, data } = await api("/api/wargame/spec", { method: "POST", body: JSON.stringify(body) });
      if (data.ok) console.log(`✅ Issues creados: ${data.ids.join(", ")}`);
      else console.error(`❌ HTTP ${status}: ${data.error}`);
      break;
    }
    default:
      console.log(`Wargame CLI — loop omnipresente (W34)
Uso: node scripts/wargame-cli.mjs <comando>

  status            Tablero: conteo por estado
  issues [wN]       Lista de issues (opcional: filtrar por wargame)
  resume <id>       Devuelve un issue needs_human a la cola
  spec <file.json>  Crea issues desde un spec no interactivo

Auth: WARGAME_TOKEN env o ~/.wargame-token`);
  }
}

main().catch((e) => { console.error("❌", e?.message || e); process.exit(1); });
