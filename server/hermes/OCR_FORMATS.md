# Estilos de estados de cuenta soportados por el parser local (local.mjs)

El agente Hermes usa OCR local (PaddleOCR) + un parser heurístico (sin IA) para
extraer movimientos. Cada banco/app tiene su propio formato visual; estos son
los estilos identificados empíricamente con las imágenes reales.

## BBVA (app bancaria) → cuenta BBVANOMINA

- Título de la pantalla: "Movimientos"
- Fechas en texto español: "15 julio 2026"
- Cada movimiento: línea de importe (columna derecha, con signo `$-`) + una o
  dos líneas de descripción (columna izquierda): "Spei enviado stp",
  "Transferencia interbancaria enviada", "Pago de nómina", "Movimiento BBVA"
- La palabra "BBVA" aparece en el texto ("Movimiento BBVA") → `guessBank` = bbva
- Dirección: signo `-`/`$-` = out, sin signo = in

## UALA (tarjeta de crédito, app UALA) → cuenta UALACC

- Título de la pantalla: "Últimos movimientos"
- Etiquetas: "Consumo", "Pago de tarjeta de crédito", "Devolución",
  "Operación rechazada", "Con dinero en cuenta"
- Fechas: "13/08" o "29/12/2025" (dd/mm, año implícito o explícito)
- El importe va EMBEBIDO al final de la línea de descripción:
  `"F AHORRO MMGX TANGANXOPATZ... $ 869.00"`
  o en línea separada a la derecha (`$798.75`)
- NO aparece el nombre "uala" en el texto → se detecta por formato:
  "últimos movimientos" + etiquetas de tarjeta + fecha corta dd/mm
- Dirección: "Consumo" = out (cargo); "Pago de tarjeta de crédito" = in;
  "Devolución" = in
- OJO: los comercios "MERCADOPAGO", "PAYPAL" aparecen como pagos DENTRO del
  estado y NO deben confundirse con el banco → el estilo de app se evalúa
  ANTES que los nombres de banco en `guessBank`.

## Cómo añadir un banco nuevo

1. Analiza una imagen de muestra con `ocr_server_paddle.py` (POST /ocr) y
   observa el texto con coordenadas `y x texto`.
2. Añade las palabras clave al estilo en `guessBank()` de `server/hermes/local.mjs`.
3. Añade la entrada al `bankAccountMap` de `server/hermes/config.json`:
   `{ "<banco>": "<accountId>" }`.
4. Prueba con `node /tmp/test_local.mjs` (reemplaza por el texto OCR real).
