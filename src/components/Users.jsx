import { useState } from "react";
import { useStore } from "../store.jsx";
import { ALL_SECTIONS, createUser, deleteUser, loadUsers } from "../auth.js";
import { Btn, Field, Glass, inputCls } from "./UI.jsx";

/** Administración de usuarios secundarios con permisos por sección y por cuenta. Solo admin. */
export default function Users({ session }) {
  const { state } = useStore();
  const [users, setUsers] = useState(loadUsers());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sections, setSections] = useState(["inicio", "movimientos"]);
  const [accountIds, setAccountIds] = useState([]);
  const [allAccounts, setAllAccounts] = useState(false);
  const [msg, setMsg] = useState("");

  if (session?.role !== "admin") {
    return <Glass><p className="text-sm text-ink-dim">Solo el administrador puede gestionar usuarios.</p></Glass>;
  }

  const toggleSection = (id) =>
    setSections((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleAccount = (id) =>
    setAccountIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = async (e) => {
    e.preventDefault();
    setMsg("");
    if (password.length < 6) {
      setMsg("⚠ La contraseña debe tener al menos 6 caracteres.");
      return;
    }
    try {
      const updated = await createUser({
        username,
        password,
        sections,
        accounts: allAccounts ? "all" : accountIds,
      });
      setUsers(updated);
      setUsername(""); setPassword(""); setSections(["inicio", "movimientos"]); setAccountIds([]); setAllAccounts(false);
      setMsg("✓ Usuario creado.");
    } catch (err) {
      setMsg(`⚠ ${err.message}`);
    }
  };

  const remove = (name) => {
    if (!confirm(`¿Eliminar al usuario "${name}"?`)) return;
    setUsers(deleteUser(name));
  };

  return (
    <Glass aria-label="Gestión de usuarios">
      <h2 className="mb-1 text-base font-semibold">Usuarios</h2>
      <p className="mb-3 text-xs text-ink-dim">Crea usuarios secundarios y elige a qué secciones y cuentas tienen acceso.</p>

      {/* Lista actual */}
      <ul className="mb-4 space-y-1.5">
        {users.map((u) => (
          <li key={u.username} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
            <div>
              <p className="text-sm font-medium">{u.username} {u.role === "admin" && <span className="text-xs text-gold">· administrador</span>}</p>
              <p className="text-xs text-ink-dim">
                {u.sections === "all" ? "Todas las secciones" : `${(u.sections || []).length} secciones`}
                {" · "}
                {u.accounts === "all" ? "todas las cuentas" : `${(u.accounts || []).length} cuentas`}
              </p>
            </div>
            {u.username !== "admin" && (
              <Btn variant="danger" className="!px-2.5 !py-1.5 text-xs" onClick={() => remove(u.username)} aria-label={`Eliminar usuario ${u.username}`}>🗑</Btn>
            )}
          </li>
        ))}
      </ul>

      {/* Alta */}
      <form onSubmit={submit} className="space-y-3 rounded-2xl border border-white/8 p-3">
        <p className="text-sm font-semibold">+ Nuevo usuario</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Usuario">
            <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" />
          </Field>
          <Field label="Contraseña" hint="Mínimo 6 caracteres.">
            <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-ink-dim">Secciones con acceso</legend>
          <div className="flex flex-wrap gap-1.5">
            {ALL_SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => toggleSection(s.id)}
                className={`rounded-full px-3 py-1 text-xs transition ${sections.includes(s.id) ? "bg-accent text-base-950 font-semibold" : "bg-white/8 text-ink-dim"}`}
                aria-pressed={sections.includes(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-ink-dim">Cuentas con acceso</legend>
          <label className="mb-1.5 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={allAccounts} onChange={(e) => setAllAccounts(e.target.checked)} />
            Todas las cuentas (incluye futuras)
          </label>
          {!allAccounts && (
            <div className="flex flex-wrap gap-1.5">
              {state.accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggleAccount(a.id)}
                  className={`rounded-full px-3 py-1 text-xs transition ${accountIds.includes(a.id) ? "bg-gain text-base-950 font-semibold" : "bg-white/8 text-ink-dim"}`}
                  aria-pressed={accountIds.includes(a.id)}
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </fieldset>

        {msg && <p className="text-xs font-medium" role="status">{msg}</p>}
        <Btn type="submit" className="!py-2 text-sm">Crear usuario</Btn>
      </form>
    </Glass>
  );
}
