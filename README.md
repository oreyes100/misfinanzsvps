# Mis finazas

MVP de finanzas personales avanzado. React 19 · Tailwind CSS v4 · Framer Motion.

**Producción**: https://mis-finazas-gold.vercel.app (Vercel, plan Hobby). Redeploy: `vercel --prod`.

## Sincronización en la nube

Backend serverless en [api/sync.js](api/sync.js) (Vercel Functions + Vercel Blob privado, store `mis-finazas-db`).
En Ajustes → "Sincronización en la nube" se genera un código único (UUID) que actúa como llave:
los datos se suben automáticamente (debounce 1,5 s ante cambios relevantes) y cualquier dispositivo
con el código restaura el mismo estado. El primer GET de un código inexistente se lee con
cache-buster para evitar 404 cacheados por el CDN de Blob. En desarrollo, Vite proxyea `/api`
a producción ([vite.config.js](vite.config.js)).

## Ejecutar

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # producción → dist/
```

## Funcionalidades

- **Intereses automáticos**: cada cuenta de ahorro/depósito tiene tasa TAE y frecuencia de devengo (diaria/mensual) configurables en Ajustes. Al abrir la app se calculan y registran las ganancias pendientes como transacciones automáticas.
- **Transferencias entre cuentas** con paso de confirmación explícito y conversión de divisa en tiempo real cuando origen y destino difieren.
- **Multimoneda**: EUR, USD, GBP, MXN (+ BTC/ETH). Divisa base seleccionable; todo el patrimonio se convierte al vuelo con tasas simuladas en vivo.
- **Portfolio multiactivo** en Bento Grid asimétrica: patrimonio neto (celda dominante), cripto con apreciación/pérdida en tiempo real, oro (€/g) e inmuebles (valoración por API simulada).
- **IA integrada**:
  - Categorización automática por descripción ("Dominos Pizza" → Comida) con puntuación de confianza, y escaneo de recibos OCR (demo).
  - Asistente agéntico con *human-in-the-loop*: analiza la petición, **previsualiza la acción** (registrar gasto, transferir, programar transferencia, ajustar límite) y solo la ejecuta tras aprobación.
  - Entrada por voz (Web Speech API, es-ES): «gasté 20 euros en cena».
- **UI**: Glassmorphism 2.0 con refracción animada, modo oscuro azul marino por defecto, micro-interacciones <300 ms (`framer-motion` + botones depresibles), bottom nav móvil, verde=ganancia / rojo=pérdida, indicadores de cifrado y biometría.
- **Accesibilidad WCAG 2.2**: contraste ≥4.5:1, foco visible de 3 px, navegación completa por teclado, `aria-live` en chat y sugerencias IA, gráficos SVG con `role="img"` y descripciones, skip-link, `prefers-reduced-motion`.

## Arquitectura

```
src/
  store.jsx          estado global (useReducer + Context), persistencia localStorage,
                     devengo de intereses, simulación de mercado (tick 4 s)
  utils.js           conversión FX, formato, categorizador IA por reglas, parser NL de voz/chat
  components/
    Dashboard.jsx    bento grid (patrimonio, cripto, oro, inmuebles, límite, cuentas, donut)
    Manage.jsx       pestaña Gestión: segmentos Cuentas / Categorías
    Accounts.jsx     CRUD de cuentas; tasa TAE + frecuencia de abono para inversión/ahorro/depósito
    Categories.jsx   CRUD de categorías de gastos e ingresos (color, palabras clave para la IA)
    Assistant.jsx    chat agéntico + voz + previsualización de acciones
    Modals.jsx       transferencia (2 pasos) y alta de movimiento (IA + OCR)
    Transactions.jsx historial con búsqueda y filtro por categoría
    Settings.jsx     divisa base, límite, tasas de interés, programadas
    Charts.jsx       LineChart y PieChart SVG accesibles
    UI.jsx           Glass, Btn, Money, Modal, SecurityBadge
```

Nota: precios y OCR son simulaciones locales; en producción se conectarían APIs reales (mercado, visión por IA) sin cambiar la arquitectura del store.
