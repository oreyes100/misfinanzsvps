# Deploy a VPS — Procedimiento de conexión y actualización

> Producción: `https://dineroorganizado.duckdns.org/` (servida por el VPS `vps-demo-n2`).

## 1. Topología de red

```
Internet
  │
  ├─ 207.248.113.8:80/443  → edge 192.168.1.34:80/443  (nginx, proxy del sitio)
  ├─ 207.248.113.8:2223    → pfSense SSH (admin)       ← ÚNICA entrada SSH desde WAN
  │
  └─ pfSense (LAN)
       ├─ 192.168.1.34  → edge (nginx + panel backend)
       └─ 192.168.0.198 → VPS `vps-demo-n2` (mis-finanzas + nginx + server.mjs)
```

- El NAT de pfSense para SSH directo al VPS (WAN `2300` → `192.168.0.198`) **no está activo**
  (regla de filtro ausente). La ruta real es: **WAN → pfSense → VPS**.
- El sitio en vivo se sirve del web root `/var/www/misfinanzas` del VPS.
- App en `/home/devops/mis-finanzas` (usuarios de la app: `devops`, `www-data` para el web root).

## 2. Conexión (cadena SSH)

Requisitos: `sshpass` (macOS: `brew install sshpass`).

```bash
# Paso 1 — SSH a pfSense (usuario admin, clave en $PFSENSE_PASS)
sshpass -p "$PFSENSE_PASS" ssh -p 2223 -o StrictHostKeyChecking=accept-new admin@207.248.113.8

# Paso 2 — Desde pfSense, salto al VPS (usuario devops, clave en $VPS_PASS)
# (desde la shell de pfSense)
ssh devops@192.168.0.198

# Alternativa en un solo comando (ProxyJump vía pfSense):
sshpass -p "$VPS_PASS" ssh -o ProxyCommand="sshpass -p '$PFSENSE_PASS' ssh -p 2223 -W %h:%p admin@207.248.113.8" \
  devops@192.168.0.198 'hostname; whoami'
```

Para rsync (misma cadena):

```bash
sshpass -p "$VPS_PASS" rsync -az \
  -e "sshpass -p '$VPS_PASS' ssh -o StrictHostKeyChecking=accept-new -o ProxyCommand=\"sshpass -p '$PFSENSE_PASS' ssh -p 2223 -W %h:%p admin@207.248.113.8\"" \
  src/ devops@192.168.0.198:~/mis-finanzas/src/
```

> ⚠️ Las contraseñas no se guardan en el repo. Definirlas como variables de entorno
> (`export PFSENSE_PASS=...`, `export VPS_PASS=...`) antes de ejecutar.

## 3. Procedimiento de update

1. **Comprobar estado actual** (qué asset sirve producción):

```bash
curl -s https://dineroorganizado.duckdns.org/ | grep -oE "assets/index-[A-Za-z0-9_-]+\.js"
# En el VPS: el mismo asset debe aparecer en /var/www/misfinanzas/index.html
```

2. **Sincronizar código** desde local (HEAD de GitHub) → VPS:

```bash
cd ~/No\ sync/Proyectos/Obsidian\ Vault/misfinanzsvps
sshpass -p "$VPS_PASS" rsync -az --delete \
  -e "sshpass -p '$VPS_PASS' ssh -o StrictHostKeyChecking=accept-new -o ProxyCommand=\"sshpass -p '$PFSENSE_PASS' ssh -p 2223 -W %h:%p admin@207.248.113.8\"" \
  src/ devops@192.168.0.198:~/mis-finanzas/src/
```

   - Solo se sincroniza `src/`. Los cambios del server (`server/hermes/*`, no commiteados)
     en el VPS **no se tocan**.
   - `--delete` mantiene `src/` idéntico a local. Comprobar antes con `-n` (dry-run):
     `rsync -avzn --delete ... src/ devops@192.168.0.198:~/mis-finanzas/src/`.

3. **Construir en el VPS** (usuario `devops` con sudo NOPASSWD):

```bash
# Si node_modules o dist quedaron como root tras un build previo:
sshpass -p "$VPS_PASS" ssh ... devops@192.168.0.198 'sudo chown -R devops:devops ~/mis-finanzas/node_modules ~/mis-finanzas/dist'

sshpass -p "$VPS_PASS" ssh ... devops@192.168.0.198 'cd ~/mis-finanzas && npm run build 2>&1 | tail -12'
```

   - Errores tipo `EACCES ... .vite-temp` ⇒ arreglar ownership con el `chown` de arriba.

4. **Publicar al web root**:

```bash
sshpass -p "$VPS_PASS" ssh ... devops@192.168.0.198 'sudo cp -r ~/mis-finanzas/dist/* /var/www/misfinanzas/'
```

5. **Verificar producción** (el nuevo asset + el chunk lazy del módulo nuevo):

```bash
curl -s https://dineroorganizado.duckdns.org/ | grep -oE "assets/index-[A-Za-z0-9_-]+\.js"
curl -s -o /dev/null -w "McpMenu: HTTP %{http_code}\n" \
  https://dineroorganizado.duckdns.org/assets/McpMenu-*.js
curl -s -o /dev/null -w "index.html: HTTP %{http_code}\n" https://dineroorganizado.duckdns.org/
```

   - `McpMenu` no aparece en el HTML (es lazy-loaded); comprobar que el chunk se sirve con HTTP 200.

## 4. Troubleshooting

| Síntoma | Causa | Solución |
|---|---|---|
| `nc -z 207.248.113.8 2300` cerrado | NAT del VPS sin regla de filtro | Entrar por `2223` (pfSense) → salto al VPS |
| `EACCES .vite-temp` en build | `node_modules`/`dist` de root | `sudo chown -R devops:devops ~/mis-finanzas/{node_modules,dist}` |
| `grep: Invalid range end` | `[^"]` en shells/doble-quotes | Usar `grep -oE "assets/index-[A-Za-z0-9_-]+\.js"` |
| Sitio muestra asset viejo | web root desactualizado | Repetir paso 4 (`cp dist/* /var/www/misfinanzas/`) |
| Sync lento/cuelga POST grande | MTU (ver Wiki/Hallazgos-Fixes-Sync-Cloud.md) | Ruta /32 en el edge; si persiste, revisar MTU 1500 |

## 5. Reglas de seguridad

- **NO** reiniciar pfSense ni pvececyte (`192.168.1.254`).
- **NO** tocar `capuvps` (`192.168.1.33`).
- **NO** guardar contraseñas en este repo ni en código fuente.
- **NO** hacer push sin `npm run build` exitoso; **NO** commitear sin `npm test` exitoso.
- Solo se modifica `src/` en el VPS; los cambios no commiteados del server se preservan.