import { API_BASE } from "./utils.js";

const USERS_KEY = "mis-finazas-users";
const SESSION_KEY = "mis-finazas-session";
const PBKDF2_ITER = 100_000;

export const ALL_SECTIONS = [
  { id: "inicio", label: "Inicio (Dashboard)" },
  { id: "movimientos", label: "Movimientos" },
  { id: "gestion", label: "Gestión" },
  { id: "reportes", label: "Reportes" },
  { id: "auditoria", label: "Auditoría" },
  { id: "asistente", label: "Asistente IA" },
  { id: "congregacion", label: "Congregación (Cuentas)" },
  { id: "ajustes", label: "Ajustes" },
];

export function generateSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(buf);
}

export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256);
  return hex(bits);
}

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

export async function pushCloudUsers(users) {
  try {
    await fetch(`${API_BASE}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ users }),
    });
  } catch {}
}

function mergeUsers(local, cloud) {
  const byName = new Map();
  for (const u of local) byName.set(u.username.toLowerCase().trim(), u);
  for (const u of cloud) {
    const key = u.username.toLowerCase().trim();
    const existing = byName.get(key);
    // Cloud responses are sanitized (no hash/salt) for security.
    // Preserve credentials from local version if we have them.
    if (existing && existing.hash && existing.salt) {
      byName.set(key, { ...u, hash: existing.hash, salt: existing.salt });
    } else {
      byName.set(key, u);
    }
  }
  return [...byName.values()];
}

export async function ensureSeed() {
  let users = loadUsers();
  const cloud = await pullCloudUsers();
  if (cloud && cloud.length) {
    users = mergeUsers(users, cloud);
    saveUsers(users);
  } else if (cloud !== null) {
    await pushCloudUsers(users);
  }
  return users;
}

export function needsSetup() {
  return loadUsers().length === 0;
}

export async function setupAdmin(password) {
  if (loadUsers().length > 0) throw new Error("Ya existe un administrador.");
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  const admin = {
    username: "admin",
    hash, salt,
    role: "admin",
    sections: "all",
    accounts: "all",
    created: new Date().toISOString(),
  };
  saveUsers([admin]);
  await pushCloudUsers([admin]);
  return admin;
}

export async function login(username, password) {
  await ensureSeed();
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase().trim());
  if (!user) return null;
  let valid = false;
  if (user.salt) {
    valid = (await hashPassword(password, user.salt)) === user.hash;
  } else {
    valid = (await sha256(password)) === user.hash;
    if (valid) {
      user.salt = generateSalt();
      user.hash = await hashPassword(password, user.salt);
      saveUsers(users);
      pushCloudUsers(users);
    }
  }
  if (!valid) return null;
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
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  users.push({ username: username.trim(), hash, salt, role: "user", sections, accounts, created: new Date().toISOString() });
  saveUsers(users);
  await pushCloudUsers(users);
  return users;
}

export async function changePassword(username, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");
  const users = loadUsers();
  const u = users.find((x) => x.username.toLowerCase() === username.toLowerCase().trim());
  if (!u) throw new Error("Usuario no encontrado.");
  u.salt = generateSalt();
  u.hash = await hashPassword(newPassword, u.salt);
  saveUsers(users);
  await pushCloudUsers(users);
  return users;
}

export function deleteUser(username) {
  if (username === "admin") throw new Error("No se puede eliminar al administrador.");
  const users = loadUsers().filter((u) => u.username !== username);
  saveUsers(users);
  pushCloudUsers(users);
  return users;
}

export function canAccess(session, sectionId) {
  if (!session) return false;
  if (session.sections === "all" || session.role === "admin") return true;
  return Array.isArray(session.sections) && session.sections.includes(sectionId);
}

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
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
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
