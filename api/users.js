import { get, put } from "@vercel/blob";

// Lista global de usuarios de la app (credenciales de acceso). Vive en un único
// blob compartido para que un usuario creado en un dispositivo pueda iniciar
// sesión desde cualquier otro. Nota: el control de acceso es client-side (ver
// auth.js); el blob es de acceso "private" (solo accesible vía esta función).
const KEY = "users/global.json";
const MAX_BYTES = 500_000;

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const result = await get(KEY, { access: "private", useCache: false });
      if (!result) return res.status(200).json({ users: [] });
      const data = JSON.parse(await new Response(result.stream).text());
      return res.status(200).json({ users: Array.isArray(data.users) ? data.users : [] });
    } catch {
      return res.status(500).json({ error: "Error leyendo usuarios." });
    }
  }

  if (req.method === "POST") {
    const body = req.body;
    if (!body || !Array.isArray(body.users)) {
      return res.status(400).json({ error: "Lista de usuarios inválida." });
    }
    const payload = JSON.stringify({ users: body.users, updatedAt: Date.now() });
    if (Buffer.byteLength(payload) > MAX_BYTES) {
      return res.status(413).json({ error: "Lista demasiado grande." });
    }
    try {
      await put(KEY, payload, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ error: "Error guardando usuarios." });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método no permitido." });
}
