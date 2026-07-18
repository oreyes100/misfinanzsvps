import { useState } from "react";
import { useStore } from "../store.jsx";
import { ALL_SECTIONS, changePassword, createUser, deleteUser, loadUsers } from "../auth.js";
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
  const [adminPw, setAdminPw] = useState("");
  const [msg, setMsg] = useState("");
  const [pwUser, setPwUser] = useState(null);   // username con el editor de contraseña abierto
  const [pwValue, setPwValue] = useState("");
  const [pwActor, setPwActor] = useState("");   // contraseña actual del admin que autoriza
  const [pwMsg, setPwMsg] = useState("");

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
        actorPassword: adminPw,
      });
      setUsers(updated);
      setUsername(""); setPassword(""); setSections(["inicio", "movimientos"]); setAccountIds([]); setAllAccounts(false); setAdminPw("");
      setMsg("✓ Usuario creado.");
    } catch (err) {
      setMsg(`⚠ ${err.message}`);
    }
  };

  const remove = (name) => {
    if (!confirm(`¿Eliminar al usuario "${name}"?`)) return;
    setUsers(deleteUser(name));
  };

  const openPw = (name) => {
    setPwUser((cur) => (cur === name ? null : name));
    setPwValue("");
    setPwActor("");
    setPwMsg("");
  };

  const savePw = async (e) => {
    e.preventDefault();
    setPwMsg("");
    try {
      // El servidor exige autorización real: usuario cambiando su propia contraseña
      // (currentPassword) o admin autorizando (actorUsername + actorPassword).
      const auth = pwUser === session.username
        ? { currentPassword: pwActor }
        : { actorUsername: session.username, actorPassword: pwActor };
      const updated = await changePassword(pwUser, pwValue, auth);
      setUsers(updated);
      setPwMsg(`✓ Contraseña de "${pwUser}" actualizada.`);
      setPwValue("");
      setPwActor("");
      setPwUser(null);
    } catch (err) {
      setPwMsg(`⚠ ${err.message}`);
    }
  };

  return (
    <Glass aria-label="Gestión de usuarios">
      <h2 className="mb-1 text-base font-semibold">Usuarios</h2>
      <p className="mb-3 text-xs text-ink-dim">Crea usuarios secundarios y elige a qué secciones y cuentas tienen acceso.</p>

      {/* Lista actual */}
      <ul className="mb-4 space-y-1.5">
        {users.map((u) => (
          <li key={u.username} className="rounded-xl bg-white/5 px-3 py-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{u.username} {u.role === "admin" && <span className="text-xs text-gold">· administrador</span>}</p>
                <p className="text-xs text-ink-dim">
                  {u.sections === "all" ? "Todas las secciones" : `${(u.sections || []).length} secciones`}
                  {" · "}
                  {u.accounts === "all" ? "todas las cuentas" : `${(u.accounts || []).length} cuentas`}
                </p>
              </div>
              <div className="flex gap-1.5">
                <Btn variant="ghost" className="!px-2.5 !py-1.5 text-xs" onClick={() => openPw(u.username)} aria-label={`Cambiar contraseña de ${u.username}`}>🔑 Contraseña</Btn>
                {u.username !== "admin" && (
                  <Btn variant="danger" className="!px-2.5 !py-1.5 text-xs" onClick={() => remove(u.username)} aria-label={`Eliminar usuario ${u.username}`}>🗑</Btn>
                )}
              </div>
            </div>

            {pwUser === u.username && (
              <form onSubmit={savePw} className="mt-2 space-y-2 border-t border-white/8 pt-2">
                <input
                  className={`${inputCls} w-full`}
                  type="password"
                  value={pwActor}
                  onChange={(e) => setPwActor(e.target.value)}
                  placeholder={u.username === session.username
                    ? "Tu contraseña actual…"
                    : `Tu contraseña de administrador (${session.username})…`}
                  autoComplete="current-password"
                  aria-label="Contraseña de autorización"
                  required
                  minLength={6}
                />
                <div className="flex flex-wrap gap-2">
                  <input
                    className={`${inputCls} min-w-44 flex-1`}
                    type="password"
                    value={pwValue}
                    onChange={(e) => setPwValue(e.target.value)}
                    placeholder={`Nueva contraseña para ${u.username}…`}
                    autoComplete="new-password"
                    aria-label={`Nueva contraseña para ${u.username}`}
                    required
                    minLength={6}
                  />
                  <Btn type="submit" className="shrink-0 !py-2 text-xs">Guardar</Btn>
                  <Btn variant="ghost" type="button" className="shrink-0 !py-2 text-xs" onClick={() => setPwUser(null)}>Cancelar</Btn>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
      {pwMsg && <p className="mb-3 text-xs font-medium" role="status">{pwMsg}</p>}

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

        <Field label="Tu contraseña de administrador" hint="Para autorizar la creación en la nube.">
          <input className={inputCls} type="password" value={adminPw} onChange={(e) => setAdminPw(e.target.value)} required autoComplete="current-password" minLength={6} />
        </Field>

        {msg && <p className="text-xs font-medium" role="status">{msg}</p>}
        <Btn type="submit" className="!py-2 text-sm">Crear usuario</Btn>
      </form>
    </Glass>
  );
}
