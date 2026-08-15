// journal.mjs — Bitácora JSONL del agente Hermes.

import fs from "node:fs";
import path from "node:path";

export function appendJournal(journalFile, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.appendFileSync(journalFile, line + "\n");
}

export function readJournal(journalFile, limit = 20) {
  if (!fs.existsSync(journalFile)) return [];
  const lines = fs.readFileSync(journalFile, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}