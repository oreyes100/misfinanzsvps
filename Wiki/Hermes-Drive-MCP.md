# Hermes Drive → Mis Finanzas (MCP + watcher automático)

Automatiza el reconocimiento de transacciones a partir de fotos subidas a una
**carpeta pública compartida de Google Drive**. Cuando subes una imagen
(estado de cuenta, recibo, comprobante) a la carpeta, se procesa
automáticamente: PaddleOCR → parser local → transacciones en SQLite → la
webapp las ve en el siguiente sync.

## Arquitectura

```
Google Drive (carpeta pública)
        │  listDrivePublic (scrape embeddedfolderview, sin OAuth)
        ▼
drive-mcp.mjs  ── 2 modos:
  1) systemd hermes-drive-watch  → daemon de polling (cada 30 s) que descarga
     imágenes nuevas a drive-downloads/, las procesa con processImage() y las
     registra en SQLite. Idempotente: guarda estado en drive-state.json.
  2) MCP server stdio (registrado en Hermes Agent) → tools para que el agente
     de Nous Research consulte/procese Drive bajo demanda.
        ▼
processor.mjs  (núcleo reutilizable del pipeline)
   OCR local (ocrUrl, PaddleOCR) → parseOcrText (local.mjs) → [fallback Gemini]
   → dispatch por tipo (statement/transfer/receipt) → apply.saveState (SQLite)
        ▼
server/data/misfinanzas.db  (sync_docs)  →  webapp (sync cada 5 min)
```

## Instalación / componentes

| Componente | Ruta |
|---|---|
| Núcleo del pipeline | `server/hermes/processor.mjs` |
| Acceso a Drive público | `server/hermes/drive.mjs` |
| Servidor MCP + watcher | `server/hermes/drive-mcp.mjs` |
| Config | `server/hermes/config.json` → clave `drive` |
| Servicio systemd | `/etc/systemd/system/hermes-drive-watch.service` |
| Registro MCP en Hermes | `~/.hermes/config.yaml` → `mcp_servers` |
| Tracking de procesados | `/home/devops/drive-state.json` |
| Descargas temporales | `/home/devops/drive-downloads/` |

Dependencias npm (en `server/`): `@modelcontextprotocol/sdk`, `zod`.

## Config (`config.json`)

```json
{
  "syncCode": "mf-...",
  "ocrUrl": "http://127.0.0.1:8765",
  "drive": {
    "folderUrl": "https://drive.google.com/drive/folders/<ID>",
    "downloadDir": "/home/devops/drive-downloads",
    "stateFile": "/home/devops/drive-state.json",
    "pollIntervalMs": 30000,
    "enabled": true
  }
}
```

`folderUrl` acepta el enlace completo o solo el ID de la carpeta.

## Tools MCP expuestas a Hermes Agent

| Tool | Descripción |
|---|---|
| `drive_list_pending` | Lista imágenes nuevas aún no procesadas |
| `drive_process_pending` | Descarga y procesa todas las nuevas (OCR→DB) |
| `drive_status` | Estado del tracking (procesados, fallidos, errores) |
| `drive_retry_failed` | Reintenta los archivos que fallaron |

Naming en Hermes Agent: `mcp__hermes-drive__drive_status`, etc.

## Modo daemon (systemd)

```bash
systemctl enable --now hermes-drive-watch.service
journalctl -u hermes-drive-watch.service -f
```

El servicio corre como `devops` y vigila la carpeta cada `pollIntervalMs`.
Solo descarga archivos cuyo `fileId` no esté en `drive-state.json` (processed o
failed), así que reprocesar es imposible y los fallos se pueden reintentar con
`drive_retry_failed`.

## Uso manual

```bash
cd /home/devops/mis-finanzas/server/hermes
node drive-mcp.mjs --sync      # un ciclo de sync y sale
node drive-mcp.mjs --status    # estado del tracking
node drive-mcp.mjs --watch     # daemon (lo usa systemd)
node drive-mcp.mjs             # servidor MCP stdio (lo usa Hermes)
```

## Notas de Drive público

- No requiere OAuth: usa `https://drive.google.com/embeddedfolderview?id=...#list`.
- Google cambió el HTML: los IDs van en `id="entry-<FILEID>"` (antes `data-id`).
  `drive.mjs` maneja ambos formatos.
- Descarga vía `https://drive.usercontent.google.com/download?id=<ID>&export=download`.
- Solo imágenes (jpg/png/webp/heic/heif/gif/pdf). PDFs se descargan pero el
  OCR actual procesa imágenes; para PDFs se espera pipeline futuro.