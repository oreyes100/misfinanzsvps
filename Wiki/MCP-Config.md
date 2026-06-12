---
title: Configuración MCP Mis Finanzas
tags: [mcp, config, filesystem, github, context7, claude]
source: Methodology - Claude Workflow Stack.md + BLUEPRINT_Agent_Memory_Architecture.md + AionUi - Integración de Agentes CLI.md
---

# Configuración MCP — Mis Finanzas

## 1. Filesystem MCP (OBLIGATORIO — Base)
**Qué hace**: Lee/escribe archivos del proyecto directamente.
**Por qué**: Permite a Claude editar `store.jsx`, `utils.js`, componentes, configs sin copy-paste.

```json
// .cursor/mcp.json o claude_desktop_config.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/jorge/No sync/Mis finazas"]
    }
  }
}
```
**Verificación**: En chat, pedir "lista archivos en src/components/" — debe responder sin pegar.

---

## 2. GitHub MCP (RECOMENDADO — Repo Activo)
**Qué hace**: Navega repo, lee PRs, issues, código, crea branches/PRs.
**Por qué**: Mis Finanzas tiene repo en GitHub. Permite code review, crear PRs, ver historial.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<tu_token_ghp_...>"
      }
    }
  }
}
```
**Token**: Settings → Developer settings → Personal access tokens → Classic → `repo` scope.
**Verificación**: "Muestra últimos 5 commits de main" — debe responder con hash, autor, mensaje.

---

## 3. Context7 MCP (RECOMENDADO — Docs Actualizadas)
**Qué hace**: Feeds docs oficiales reales de librerías (React 19, Tailwind v4, Vite 6, Framer Motion, tesseract.js, Vercel Blob).
**Por qué**: Elimina alucinaciones sobre APIs cambiantes. Docs siempre frescas.

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"]
    }
  }
}
```
**Verificación**: "¿Cuál es la API de `useReducer` en React 19?" — debe citar docs oficiales.

---

## 4. Playwright MCP (OPCIONAL — Testing UI)
**Qué hace**: Controla browser real — click, fill, screenshot, assert.
**Cuándo**: Para testear flujos Assistant (voz, OCR), transferencias, sync cloud.
**Costo**: Más lento, usa para verificación crítica pre-deploy.

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-playwright"],
      "env": { "PLAYWRIGHT_BROWSERS_PATH": "0" }
    }
  }
}
```

---

## 5. PostgreSQL / SQLite MCP (NO APLICA — Sin BD Server)
Mis Finanzas usa **localStorage + Vercel Blob** — no hay PostgreSQL/SQLite server.
**Alternativa**: Si migras a Supabase/SQLite local → agregar MCP correspondiente.

---

## 6. Brave Search MCP (OPCIONAL — Research)
**Qué hace**: Búsqueda web en tiempo real (post-cutoff).
**Cuándo**: Investigar librerías nuevas, comparar APIs, buscar bugs conocidos.

```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "<tu_key>" }
    }
  }
}
```

---

## 7. Memory MCP (OPCIONAL — Persistencia Cross-Sesión)
**Qué hace**: Recuerda preferencias, decisiones, patrones entre sesiones de chat.
**Alternativa nativa**: Ya implementado via **PMF filesystem** (`.claude/memory/`, `sessions.jsonl`, `CONTEXTO.md`).
**Recomendación**: Usar PMF nativo — más control, auditable, portable.

---

## Configuración Unificada (Recomendada)

### Para Claude Desktop / Claude.ai Projects
Archivo: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/jorge/No sync/Mis finazas"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"]
    }
  }
}
```

### Para Cursor / VS Code (`.cursor/mcp.json` en root del proyecto)
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}" }
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"]
    }
  }
}
```

---

## Verificación Post-Instalación
En nueva sesión con MCP activos, ejecutar `/boot` y verificar:
1. **Filesystem**: "Lee `src/store.jsx` líneas 1-20" → muestra SEED
2. **GitHub**: "¿Cuál es el último commit en main?" → hash + mensaje
3. **Context7**: "¿Cómo se usa `useReducer` con TypeScript en React 19?" → docs oficiales

---

## Referencias
- `Methodology - Claude Workflow Stack.md` §139-158 (Capa 4: Plugins/MCP)
- `BLUEPRINT_Agent_Memory_Architecture.md` §156-168 (Hermes Memory Providers)
- `AionUi - Integración de Agentes CLI.md` §15-16 (Gestión Unificada MCP)

---

## 🔗 Enlaces Relacionados
- [[MOC-Mis-Finanzas]] — Mapa de contenido principal
- [[Arquitectura-Estado]] — Estado global que MCP Filesystem puede leer/escribir
- [[Sync-Cloud]] — API sync que GitHub MCP puede versionar

> Fuente: `Methodology - Claude Workflow Stack.md` §139-158 + `BLUEPRINT_Agent_Memory_Architecture.md` §156-168 + `AionUi - Integración de Agentes CLI.md` §15-16