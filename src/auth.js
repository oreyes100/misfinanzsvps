// ---------- Autenticación y usuarios (client-side) ----------
// NOTA: control de acceso en cliente. Para comercialización real se requiere
// backend de autenticación (ver CONTEXTO.md → roadmap comercial).

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

/** Garantiza que el usuario admin existe. Idempotente. */
export async function ensureSeed() {
  const users = loadUsers();
  if (!users.some((u) => u.username === "admin")) {
    const hash = await sha256("Michoacan1");
    users.push({ ...ADMIN_SEED, hash, created: new Date().toISOString() });
    saveUsers(users);
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
  return users;
}

export function deleteUser(username) {
  if (username === "admin") throw new Error("No se puede eliminar al administrador.");
  const users = loadUsers().filter((u) => u.username !== username);
  saveUsers(users);
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
