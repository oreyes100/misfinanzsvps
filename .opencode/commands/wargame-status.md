---
description: "Muestra el tablero de wargames (estado, issues activos, intentos) vía wargame-cli"
---

# Wargame Status — tablero del loop

```bash
node scripts/wargame-cli.mjs status
node scripts/wargame-cli.mjs issues
```

Presenta al usuario una tabla con: **issue | estado | intentos (build/review) | título**, filtrando lo `done` al final. Si hay issues `needs_human`, destácalos con su `lastError` y sugiere `node scripts/wargame-cli.mjs resume <id>` (o `/resume <id>` en Telegram).

Si la API no responde (401/timeout): sugiere verificar `WARGAME_TOKEN` env o `~/.wargame-token`, y `WARGAME_API` si el server no es https://dineroorganizado.duckdns.org.
