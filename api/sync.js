import { get, put } from "@vercel/blob";

// Sincronización de estado por código único (bearer-id): el código actúa como
// credencial — solo quien lo conoce puede leer/escribir su copia.
const ID_RE = /^[a-z0-9-]{16,64}$/i;
const MAX_BYTES = 1_000_000;

export default async function handler(req, res) {
  const id = String(req.query.id || "");
  if (!ID_RE.test(id)) {
    return res.status(400).json({ error: "Código de sincronización inválido." });
  }
  const key = `sync/${id.toLowerCase()}.json`;

  if (req.method === "GET") {
    try {
      // URL con cache-buster: el CDN de Blob cachea respuestas (incluidos 404
      // previos a la creación), y una lectura obsoleta podría hacer que un
      // dispositivo recién vinculado pisara los datos buenos de la nube.
      const storeId = (process.env.BLOB_READ_WRITE_TOKEN || "").split("_")[3] || "";
      const url = `https://${storeId.toLowerCase()}.private.blob.vercel-storage.com/${key}?nc=${Date.now()}`;
      const result = await get(url, { access: "private" });
      if (!result) return res.status(200).json({ found: false });
      const data = JSON.parse(await new Response(result.stream).text());
      return res.status(200).json({ found: true, state: data.state, updatedAt: data.updatedAt });
    } catch {
      return res.status(500).json({ error: "Error leyendo el almacenamiento." });
    }
  }

  if (req.method === "POST") {
    const body = req.body;
    if (!body || typeof body.state !== "object" || Array.isArray(body.state)) {
      return res.status(400).json({ error: "Estado inválido." });
    }
    const payload = JSON.stringify({ state: body.state, updatedAt: Date.now() });
    if (Buffer.byteLength(payload) > MAX_BYTES) {
      return res.status(413).json({ error: "Estado demasiado grande." });
    }
    try {
      await put(key, payload, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ error: "Error guardando en el almacenamiento." });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método no permitido." });
}
