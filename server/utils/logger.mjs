// logger.mjs — W29: logging estructurado con timestamps para debugging del
// flujo bot→server→webapp. Salida a stdout/stderr (journalctl lo captura).
export function createLogger(tag) {
  const ts = () => new Date().toISOString();
  return {
    info: (msg, extra) => console.log(`[${ts()}] [${tag}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`),
    warn: (msg, extra) => console.warn(`[${ts()}] [${tag}] ⚠️ ${msg}${extra ? " " + JSON.stringify(extra) : ""}`),
    error: (msg, extra) => console.error(`[${ts()}] [${tag}] ❌ ${msg}${extra ? " " + JSON.stringify(extra) : ""}`),
  };
}
