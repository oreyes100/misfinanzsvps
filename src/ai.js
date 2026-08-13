// ai.js — Metadata de los proveedores de IA integrados (UI cliente).
export const AI_PROVIDERS = [
  {
    id: "gemini",
    name: "Google Gemini",
    model: "gemini-flash-latest",
    free: true,
    color: "#4285F4",
    keyField: "geminiKey",
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    blurb: "El que ya usa la app para escanear recibos. Plan gratuito para uso ligero.",
  },
  {
    id: "openai",
    name: "OpenAI · GPT-4o mini",
    model: "gpt-4o-mini",
    free: false,
    color: "#10A37F",
    keyField: "openaiKey",
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    blurb: "Muy preciso leyendo tickets y capturas. Pago por uso (centavos por imagen).",
  },
  {
    id: "anthropic",
    name: "Anthropic · Claude Haiku",
    model: "claude-3-5-haiku-latest",
    free: false,
    color: "#D97757",
    keyField: "anthropicKey",
    keyHint: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    blurb: "Alternativa sólida con buena comprensión de documentos. Pago por uso.",
  },
];

export function aiProviderById(id) {
  return AI_PROVIDERS.find((p) => p.id === id) || AI_PROVIDERS[0];
}

export const AI_ERROR_LABELS = {
  no_key: "Falta la clave de IA (configúrala aquí o en el servidor).",
  invalid_key: "Clave de IA inválida.",
  forbidden: "Acceso denegado por el proveedor (revisa la clave).",
  quota: "Sin cuota disponible en el proveedor (plan gratuito agotado).",
  model_missing: "El modelo no está disponible (prueba otro proveedor).",
  overloaded: "El proveedor está saturado; intenta en un momento.",
  network: "No se pudo conectar con el proveedor de IA.",
};

export function aiErrorLabel(code) {
  return AI_ERROR_LABELS[code] || AI_ERROR_LABELS.network;
}