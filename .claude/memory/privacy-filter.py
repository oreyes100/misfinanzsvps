#!/usr/bin/env python3
"""Privacy filter — Mis Finanzas. Stage 4 de BLUEPRINT_Token_Memory_Pipeline.

Excluye contenido sensible (saldos, numeros de cuenta, tokens, UUIDs de sync)
de la memoria persistente. App de finanzas => datos confidenciales NO deben
quedar en .claude/memory/ ni viajar en commits.

Uso:
  # Filtrar stdin -> stdout (pipe en /close antes de escribir memoria)
  echo "$texto" | python3 .claude/memory/privacy-filter.py

  # Auditar un archivo (exit 1 si encuentra contenido sensible sin envolver)
  python3 .claude/memory/privacy-filter.py --check .claude/memory/corrections.jsonl

  # Filtrar archivo in-place (reescribe sin bloques <private>)
  python3 .claude/memory/privacy-filter.py --scrub .claude/memory/learned-rules.md

Reglas:
  1. Todo entre <private>...</private> se elimina (literal del blueprint).
  2. Patrones sensibles detectados aunque NO esten envueltos -> --check los reporta.
"""
import re
import sys

# Bloques marcados explicitamente como privados.
PRIVATE_BLOCK = re.compile(r"<private>.*?</private>", re.DOTALL)

# Patrones sensibles especificos del dominio (para modo --check / auditoria).
SENSITIVE = [
    ("blob_token",  re.compile(r"vercel_blob_rw_[A-Za-z0-9_]+", re.I)),
    ("bearer",      re.compile(r"(?:BLOB_READ_WRITE_TOKEN|Bearer)\s*[:=]?\s*\S{12,}", re.I)),
    ("sync_uuid",   re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)),
    ("env_secret",  re.compile(r"(?:API_KEY|SECRET|PASSWORD|TOKEN)\s*=\s*\S+", re.I)),
    ("iban_clabe",  re.compile(r"\b\d{16,18}\b")),  # CLABE (18) / tarjeta (16)
    ("balance",     re.compile(r'"balance"\s*:\s*-?\d+(\.\d+)?')),
]


def scrub(text: str) -> str:
    """Elimina bloques <private> y deja marcador trazable."""
    return PRIVATE_BLOCK.sub("[REDACTED:private]", text)


def check(text: str) -> list:
    """Devuelve lista (linea, etiqueta, fragmento) de sensibles NO envueltos."""
    stripped = PRIVATE_BLOCK.sub("", text)  # ignorar lo ya protegido
    hits = []
    for i, line in enumerate(stripped.splitlines(), 1):
        for label, pat in SENSITIVE:
            m = pat.search(line)
            if m:
                frag = m.group(0)[:24]
                hits.append((i, label, frag))
    return hits


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("--check", "--scrub"):
        mode, path = args[0], args[1]
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        if mode == "--check":
            hits = check(text)
            if hits:
                for ln, label, frag in hits:
                    print(f"{path}:{ln}: SENSITIVE[{label}]: {frag}", file=sys.stderr)
                print(f"\n{len(hits)} sensibles sin <private>. Envolver o eliminar antes de commit.",
                      file=sys.stderr)
                return 1
            print(f"OK — {path} sin contenido sensible expuesto.")
            return 0
        # --scrub
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(scrub(text))
        print(f"Scrubbed {path} (bloques <private> eliminados).")
        return 0
    # default: stdin -> stdout
    sys.stdout.write(scrub(sys.stdin.read()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
