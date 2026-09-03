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
  { id: "importar", label: "Importar (IA)" },
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

/** Actor autenticado actual: {username, hash} del usuario en sesión (firma escrituras a la nube). */
function currentActor() {
  try {
    const sess = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (!sess) return null;
    const u = loadUsers().find((x) => x.username.toLowerCase() === String(sess.username).toLowerCase());
    if (u && u.hash) return { username: u.username, hash: u.hash };
  } catch {}
  return null;
}

export async function pushCloudUsers(users) {
  try {
    await fetch(`${API_BASE}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ users, actor: currentActor() }),
    });
  } catch {}
}

/** Verifica la contraseña contra la nube (el hash nunca sale del servidor). Devuelve el usuario saneado (con salt) o null. */
async function cloudVerify(username, password) {
  try {
    const r = await fetch(`${API_BASE}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", username, password }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.ok && data.user ? data.user : null;
  } catch {
    return null;
  }
}

/** Crea el admin inicial en la nube. Lanza si ya existe alguno (409). */
async function cloudSetup(user) {
  const r = await fetch(`${API_BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "setup", user }),
  });
  if (r.status === 409) throw new Error("Ya existe una cuenta en la nube. Inicia sesión con tu contraseña.");
  return r.ok;
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

/** Chequeo síncrono (solo local) — retrocompatible. Usar needsSetupCloud para la decisión real. */
export function needsSetup() {
  return loadUsers().length === 0;
}

/**
 * ¿Hay que mostrar el setup inicial? Solo si NO hay usuarios ni en local NI en
 * la nube. Si la nube ya tiene cuentas, se exige login (no setup libre): así un
 * dispositivo nuevo no puede crear un admin con cualquier contraseña.
 */
export async function needsSetupCloud() {
  if (loadUsers().length > 0) return false;
  const cloud = await pullCloudUsers();
  if (cloud === null) return loadUsers().length === 0; // sin red: decidir por local
  return cloud.length === 0;
}

export async function setupAdmin(password, username = "admin") {
  if (loadUsers().length > 0) throw new Error("Ya existe un administrador.");
  const uname = (username || "admin").trim();
  if (!uname) throw new Error("Usuario requerido.");
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  const admin = {
    username: uname,
    hash, salt,
    role: "admin",
    sections: "all",
    accounts: "all",
    created: new Date().toISOString(),
  };
  // La nube es autoritativa: crea solo si está vacía (lanza 409 si ya hay cuentas).
  await cloudSetup(admin);
  saveUsers([admin]);
  return admin;
}

export async function login(username, password) {
  await ensureSeed();
  const users = loadUsers();
  const input = username.toLowerCase().trim();
  const user = users.find((u) => u.username.toLowerCase() === input) || users.find((u) => String(u.email || "").toLowerCase() === input); // W30-fix: login también por email

  // 1) Verificación local si tenemos la credencial completa.
  if (user && user.hash) {
    let valid = false;
    if (user.salt) {
      valid = (await hashPassword(password, user.salt)) === user.hash;
    } else {
      valid = (await sha256(password)) === user.hash; // legado sin salt
      if (valid) {
        user.salt = generateSalt();
        user.hash = await hashPassword(password, user.salt);
        saveUsers(users);
        pushCloudUsers(users);
      }
    }
    if (valid) return startSession(user);
  }

  // 2) Sin credencial local válida → verificar contra la nube (el hash vive
  //    en el servidor). Al validar, cacheamos la credencial localmente.
  const cloudUser = await cloudVerify(username, password);
  if (cloudUser && cloudUser.salt) {
    const cached = { ...cloudUser, hash: await hashPassword(password, cloudUser.salt) };
    const rest = loadUsers().filter((u) => u.username.toLowerCase() !== cached.username.toLowerCase());
    saveUsers([...rest, cached]);
    return startSession(cached);
  }

  return null;
}

function startSession(user) {
  const session = { username: user.username, role: user.role, sections: user.sections, accounts: user.accounts, ts: Date.now() };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

/**
 * Sesión por biometría: WebAuthn ya probó la identidad en el dispositivo. Solo
 * concede acceso si el usuario enrolado AÚN existe (local o nube) y con SUS
 * permisos reales — no admin fijo. Si fue eliminado, deniega.
 */
export async function biometricSession(username) {
  let u = loadUsers().find((x) => x.username.toLowerCase() === String(username).toLowerCase());
  if (!u) {
    const cloud = await pullCloudUsers();
    u = (cloud || []).find((x) => x.username.toLowerCase() === String(username).toLowerCase());
  }
  if (!u) return null;
  return startSession(u);
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

export async function createUser({ username, password, sections, accounts, actorPassword }) {
  const users = loadUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase().trim())) {
    throw new Error("Ese nombre de usuario ya existe.");
  }
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  const newUser = { username: username.trim(), hash, salt, role: "user", sections, accounts, created: new Date().toISOString() };
  // Authorize via real admin password (avoids silent 403 from hash-echo approach).
  const sess = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  const actorUsername = sess?.username;
  if (!actorUsername || !actorPassword) throw new Error("Se requiere la contraseña de administrador.");
  const r = await fetch(`${API_BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create_user", user: newUser, actorUsername, actorPassword }),
  });
  if (r.status === 403) throw new Error("Contraseña de administrador incorrecta.");
  if (r.status === 409) throw new Error("Ese nombre de usuario ya existe en la nube.");
  if (!r.ok) throw new Error("No se pudo crear el usuario en la nube.");
  users.push(newUser);
  saveUsers(users);
  return users;
}

/**
 * Cambia la contraseña en el servidor autorizando con la contraseña REAL
 * (no con el eco del hash almacenado). Repara el 403 perpetuo que ocurría
 * cuando el hash local divergía del hash en nube.
 * auth = { currentPassword } | { actorUsername, actorPassword }
 */
export async function changePassword(username, newPassword, auth = {}) {
  if (!newPassword || newPassword.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");
  const uname = String(username || "").trim();
  if (!uname) throw new Error("Usuario requerido.");
  const r = await fetch(`${API_BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "change_password",
      username: uname,
      newPassword,
      currentPassword: auth.currentPassword,
      actorUsername: auth.actorUsername,
      actorPassword: auth.actorPassword,
    }),
  });
  if (r.status === 403) throw new Error("Credenciales incorrectas para autorizar el cambio.");
  if (r.status === 404) throw new Error("Usuario no encontrado en la nube.");
  if (!r.ok) throw new Error("No se pudo cambiar la contraseña (error de servidor).");
  const data = await r.json();
  if (!data.ok || !data.user || !data.user.salt) throw new Error("Respuesta de servidor inválida.");
  // Actualiza caché local con salt del server y hash recalculado desde la
  // contraseña nueva. Sin esto el usuario tendría que re-loguear.
  const users = loadUsers();
  const idx = users.findIndex((x) => x.username.toLowerCase() === uname.toLowerCase());
  const cached = { ...data.user, hash: await hashPassword(newPassword, data.user.salt) };
  if (idx >= 0) users[idx] = { ...users[idx], ...cached };
  else users.push(cached);
  saveUsers(users);
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
