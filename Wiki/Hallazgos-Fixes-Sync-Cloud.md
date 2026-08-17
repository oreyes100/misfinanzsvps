# Hallazgos y Procedimientos — Sincronización y Fixes (ago 2026)

Documento de hallazgos, causas raíz y soluciones generadas durante la puesta a
punto del sync cloud de Mis Finanzas en el entorno VPS replicado, incluida la
integración MCP de Google Drive. Todo lo aquí descrito fue verificado en
producción.

---

## 1. Pantalla azul en la vista Movimientos (crash del cliente)

### Hallazgo
Al re-activar el sync con el código real (`mf-60ec529050f44bfab1`, estado con
571 transacciones y 38 cuentas), la vista **Movimientos** quedaba en blanco /
"pantalla azul". El estado demo anterior (`392cb258-...`, 7 txs) no crasheaba.

### Causa raíz
`src/components/Transactions.jsx` (línea 160) renderizaba el chip de categoría
con `t.category.slice(0, 2).toUpperCase()`. El estado cloud real tiene **50
transacciones con `category: null`**, por lo que `null.slice()` lanzaba:

```
TypeError: Cannot read properties of null (reading 'slice')
```

El estado demo no tenía categorías `null`, por eso solo explotaba con el estado
real.

### Solución
Fallback seguro en el render:

```jsx
{(t.category || "Otro").slice(0, 2).toUpperCase()}
```

Reconstruir el bundle y desplegarlo:

```bash
cd /home/devops/mis-finanzas
npm run build
cp -r dist/* /var/www/misfinanzas/
```

### Verificación
Reproducción con Chromium headless (Playwright en el clon) inyectando el estado
cloud real: antes del fix → `PAGEERROR` al abrir Movimientos; después → lista
completa (38 cuentas, intereses automáticos, sin errores de consola).

### Commit
`5db3dab` — pusheado a `origin` y `misfinanzsvps`.

---

## 2. HTTP 408 (Request Timeout) en POST /api/sync

### Hallazgo
El navegador recibía **408** al subir el estado (~137 KB) vía
`https://dineroorganizado.duckdns.org/api/sync`. GET y POST pequeños
respondían 200 correctamente. En el clon, el POST directo a
`127.0.0.1:3000` y a `127.0.0.1:80` respondía 200 en ~0.02 s, pero el mismo
POST **desde el edge (192.168.1.34) hacia el clon (192.168.0.198) se colgaba**
a partir de ~68 KB de body.

### Causa raíz: ruta asimétrica edge → clon
- El edge es `192.168.1.34/24` y enrutaba hacia el clon (`192.168.0.198/22`)
  por el gateway `192.168.1.1`.
- El clon, al tener máscara `/22`, ve a `192.168.1.x` como **local** y
  respondía **directo** (sin pasar por el gateway).
- El gateway (firewall/conntrack) descartaba los paquetes de retorno directo
  porque no correspondían a una conexión que él había visto salir.
- Resultado: TCP quedaba en `FIN-WAIT-1`, los ACK/FIN del clon no llegaban al
  edge y los POST con cuerpo grande se colgaban hasta que nginx devolvía 408.

Diagnóstico rápido que confirmó el problema:

```bash
# edge → clon, ping con DF: 1472 OK, 1500 falla (síntoma de MTU en la ruta)
ping -M do -s 1472 192.168.0.198   # OK
ping -M do -s 1500 192.168.0.198   # 100% loss

# umbral del POST grande
for s in 1000 30000 60000 100000; do
  curl -s -o /dev/null -w "size=$s %{http_code} %{time_total}\n" \
    -X POST http://192.168.0.198/api/health --data @/tmp/t_$s.json
done
# 1000/30000/60000 → 404 rápido; 100000 → cuelga (timeout)

# conexiones del clon quedan en FIN-WAIT-1
ss -tn | grep 192.168.1.34
```

### Solución
Ruta directa `/32` en el edge hacia el clon, persistida con un servicio
systemd (el netplan/cloud-init no generó bien una ruta link-scope, así que se
usa `ip route replace`):

```bash
# en el edge (192.168.1.34)
ip route replace 192.168.0.198/32 dev eth0 src 192.168.1.34
```

Servicio `/etc/systemd/system/route-to-misfinanzas.service`:

```ini
[Unit]
Description=Añade ruta directa /32 al guest Mis Finanzas (evita ruta asimétrica por gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/ip route replace 192.168.0.198/32 dev eth0 src 192.168.1.34
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable route-to-misfinanzas.service
systemctl start route-to-misfinanzas.service
```

### Verificación
POST de 137 KB vía `https://dineroorganizado.duckdns.org/api/sync` →
**200 en 0.29 s** (antes se colgaba). Estado íntegro: 571 txs, 38 cuentas.

> Nota de troubleshooting agregada en `procedures/acceso-dominio-https.md`.

---

## 3. Clasificación de tickets como recibos (Bodega Aurrera)

### Hallazgo
El watcher clasificaba el ticket de Bodega Aurrera
(`D5992EB4-65D2-4C45-9A56-0CCE63005474_1_105_c.jpeg`, Mastercard \*\*02,
$401.74) como *transferencia* con `from=null, to=null` en vez de *recibo*, y el
monto registrado era 0 o el subtotal, no el TOTAL.

### Causa raíz
En `server/hermes/local.mjs`:
- `parseTransfer` aceptaba cualquier texto con "null" como origen/destino.
- `parseReceipt` tomaba el primer monto encontrado (o el subtotal) en vez de la
  línea TOTAL/IMPORTE/MONTO.

### Solución
- `parseTransfer` ahora exige `from`/`to` reales o keyword fuerte
  (SPEI/CLABE/transferencia); si no, devuelve `null`.
- `parseReceipt` toma el importe de la línea TOTAL/IMPORTE/MONTO ($401.74).
- `processor.mjs` `handleReceipt`: si los items del ticket no traen montos
  (columnas), registra el TOTAL como una sola transacción en vez de $0.
- `config.json` / `config.json.example`: `bankAccountMap` añade
  `bodegaaurrera`, `bodega aurrera`, `wal mart` → `a55lyg5r` (DidiCC).

### Verificación
Reproceso → `receipt (1 acción)`, transacción `-401.74 BodegaAurrera → DidiCC`
en la DB (id `qfbddjgj`, fecha 2026-08-17, categoría "Otros"). Duplicado $0
eliminado.

### Commits
- `2eac326` — fix clasificación tickets como recibos
- `5df27f2` — bankAccountMap en config.json.example

---

## 4. Acceso web por dominio y login (contexto de soporte)

- El webapp se sirve en el clon vía nginx (solo :80) → proxy `/api` a
  `127.0.0.1:3000` (server.mjs, SQLite). HTTPS público termina en el edge
  (no hay listener 443 en el clon).
- `API_BASE` en `src/utils.ts`: `""` para web (mismo origen), URL Vercel solo
  para native Capacitor.
- Dos códigos de sync distintos: `mf-60ec529050f44bfab1` = estado real (571
  txs, 38 cuentas, es el `syncCode` del pipeline); `392cb258-...` = estado demo
  (7 txs). El navegador tenía el código demo en `localStorage` bajo la clave
  `mis-finazas-sync-id`.
- Usuario `jr` (admin): contraseña reseteada a `Michoacan1.` vía
  PBKDF2 (100k iteraciones, sha256); verify vía API → `ok:true`.

---

## Referencias de diagnóstico útiles

- Estado real servido por el backend:
  `GET https://dineroorganizado.duckdns.org/api/sync?id=mf-60ec529050f44bfab1`
- DB local: `/home/devops/mis-finanzas/server/data/misfinanzas.db` (tabla
  `sync_docs`: `sync_code`, `state_json`, `updated_at`, `doc_size`).
- Bundle web desplegado: `/var/www/misfinanzas/assets/index-CrOcAw1u.js`.
- Playwright (Chromium headless) disponible en el clon:
  `/home/devops/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`.
- Reproducción del crash del cliente: inyectar en `localStorage` el estado
  cloud (`mis-finazas-v1`), la sesión de `jr` (`mis-finazas-session`) y el
  sync-id real (`mis-finazas-sync-id`), luego abrir Movimientos.
