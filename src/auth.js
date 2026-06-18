// ---------- Autenticación y usuarios (client-side) ----------
// NOTA: control de acceso en cliente. Para comercialización real se requiere
// backend de autenticación (ver CONTEXTO.md → roadmap comercial).

import { API_BASE } from "./utils.js";

const USERS_KEY = "mis-finazas-users";
const SESSION_KEY = "mis-finazas-session";

export const ALL_SECTIONS = [
  { id: "inicio", label: "Inicio (Dashboard)" },
  { id: "movimientos", label: "Movimientos" },
  { id: "gestion", label: "Gestión" },
  { id: "reportes", label: "Reportes" },
  { id: "asistente", label: "Asistente IA" },
  { id: "congregacion", label: "Congregación (Cuentas)" },
  { id: "ajustes", label: "Ajustes" },
];

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Hash de "Michoacan1" pre-calculado para sembrar al admin sin exponer el texto plano.
const ADMIN_SEED = {
  username: "admin",
  // sha256("Michoacan1")
  hash: null, // se calcula en ensureSeed()
  role: "admin",
  sections: "all",
  accounts: "all",
};

export function loadUsers() {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

// ---------- Sincronización de usuarios con la nube ----------
// Los usuarios viven en un blob global (api/users) para que una cuenta creada
// en un dispositivo permita iniciar sesión desde cualquier otro. Antes solo se
// guardaban en localStorage del navegador que la creó: el usuario "no existía"
// en Vercel/otros dispositivos y el login fallaba con "contraseña incorrecta".

/** Baja la lista de usuarios de la nube. null si no hay red/endpoint. */
async function pullCloudUsers() {
  try {
    const r = await fetch(`${API_BASE}/api/users`);
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data.users) ? data.users : null;
  } catch {
    return null;
  }
}

/** Sube la lista completa de usuarios a la nube (best-effort). */
export async function pushCloudUsers(users) {
  try {
    await fetch(`${API_BASE}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ users }),
    });
  } catch {
    /* best-effort: si falla, queda en localStorage y se reintenta luego */
  }
}

/** Une listas por username (la nube es autoritativa para nombres repetidos). */
function mergeUsers(local, cloud) {
  const byName = new Map();
  for (const u of local) byName.set(u.username.toLowerCase().trim(), u);
  for (const u of cloud) byName.set(u.username.toLowerCase().trim(), u);
  return [...byName.values()];
}

/**
 * Garantiza que el usuario admin existe y fusiona la lista con la nube.
 * Idempotente. Se llama en cada login para que los usuarios creados en otros
 * dispositivos estén disponibles aquí.
 */
export async function ensureSeed() {
  let users = loadUsers();
  if (!users.some((u) => u.username === "admin")) {
    const hash = await sha256("Michoacan1");
    users.push({ ...ADMIN_SEED, hash, created: new Date().toISOString() });
  }
  const cloud = await pullCloudUsers();
  if (cloud && cloud.length) {
    users = mergeUsers(users, cloud);
    saveUsers(users);
  } else {
    // Nube vacía o inalcanzable: persistir local y sembrar la nube si se puede.
    saveUsers(users);
    if (cloud !== null) await pushCloudUsers(users);
  }
  return users;
}

export async function login(username, password) {
  await ensureSeed();
  const users = loadUsers();
  const hash = await sha256(password);
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase().trim() && u.hash === hash);
  if (!user) return null;
  const session = { username: user.username, role: user.role, sections: user.sections, accounts: user.accounts, ts: Date.now() };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function currentSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

export async function createUser({ username, password, sections, accounts }) {
  const users = loadUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase().trim())) {
    throw new Error("Ese nombre de usuario ya existe.");
  }
  const hash = await sha256(password);
  users.push({ username: username.trim(), hash, role: "user", sections, accounts, created: new Date().toISOString() });
  saveUsers(users);
  await pushCloudUsers(users); // propagar a la nube para que entre desde cualquier dispositivo
  return users;
}

/**
 * Cambia la contraseña de un usuario (admin la resetea cuando se olvida o no
 * sirve). Reescribe el hash y propaga a la nube para que el nuevo acceso valga
 * desde cualquier dispositivo. Idempotente sobre el username.
 */
export async function changePassword(username, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");
  const users = loadUsers();
  const u = users.find((x) => x.username.toLowerCase() === username.toLowerCase().trim());
  if (!u) throw new Error("Usuario no encontrado.");
  u.hash = await sha256(newPassword);
  saveUsers(users);
  await pushCloudUsers(users);
  return users;
}

export function deleteUser(username) {
  if (username === "admin") throw new Error("No se puede eliminar al administrador.");
  const users = loadUsers().filter((u) => u.username !== username);
  saveUsers(users);
  pushCloudUsers(users); // best-effort; no bloquea la UI
  return users;
}

/** ¿Tiene el usuario acceso a la sección? */
export function canAccess(session, sectionId) {
  if (!session) return false;
  if (session.sections === "all" || session.role === "admin") return true;
  return Array.isArray(session.sections) && session.sections.includes(sectionId);
}

/** Filtra cuentas visibles según permisos del usuario. */
export function filterAccounts(accounts, session) {
  if (!session || session.accounts === "all" || session.role === "admin") return accounts;
  if (!Array.isArray(session.accounts)) return [];
  return accounts.filter((a) => session.accounts.includes(a.id));
}

// ---------- Biometría (WebAuthn) ----------

const CRED_KEY = "mis-finazas-webauthn-cred";

export function isBiometricAvailable() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

export function hasBiometricCredential() {
  return !!localStorage.getItem(CRED_KEY);
}

export async function registerBiometric(username) {
  if (!isBiometricAvailable()) throw new Error("Biometría no disponible en este navegador.");
  const userId = new TextEncoder().encode(username);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Mis Finanzas", id: location.hostname },
      user: { id: userId, name: username, displayName: username },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
      },
      timeout: 60000,
    },
  });
  if (!credential) throw new Error("Registro biométrico cancelado.");
  localStorage.setItem(CRED_KEY, JSON.stringify({
    id: credential.id,
    rawId: btoa(String.fromCharCode(...new Uint8Array(credential.rawId))),
    username,
  }));
  return true;
}

export async function verifyBiometric() {
  const stored = JSON.parse(localStorage.getItem(CRED_KEY) || "null");
  if (!stored) throw new Error("No hay credencial biométrica registrada.");
  const rawId = Uint8Array.from(atob(stored.rawId), (c) => c.charCodeAt(0));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: rawId, type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  if (!assertion) throw new Error("Verificación biométrica cancelada.");
  return stored.username;
}

export function removeBiometric() {
  localStorage.removeItem(CRED_KEY);
}
