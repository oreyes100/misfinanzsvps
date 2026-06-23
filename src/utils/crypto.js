const SALT = 'mis-finazas-salt-2024-secreto'; // Cambia esto por una string aleatoria larga

export async function generateHash(uuid) {
  const encoder = new TextEncoder();
  // En el navegador usamos crypto.subtle
  if (window.crypto?.subtle) {
    const data = encoder.encode(`${uuid}:${SALT}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback para Node (si lo pruebas en Vercel localmente)
  const cryptoLib = await import('crypto');
  return cryptoLib.createHash('sha256').update(`${uuid}:${SALT}`).digest('hex');
}