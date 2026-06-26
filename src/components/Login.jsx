import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { hasBiometricCredential, isBiometricAvailable, login, needsSetup, setupAdmin, verifyBiometric } from "../auth.js";
import { Btn, inputCls } from "./UI.jsx";

const BG_VIDEO = "/finance-bg.mp4";

function SetupForm({ onDone }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (pass.length < 6) { setError("Mínimo 6 caracteres."); return; }
    if (pass !== confirm) { setError("Las contraseñas no coinciden."); return; }
    setBusy(true);
    try {
      await setupAdmin(pass);
      const session = await login("admin", pass);
      if (session) onDone(session);
      else setError("Error al iniciar sesión.");
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-ink-dim">Configura la contraseña de administrador para proteger tus datos.</p>
      <div>
        <label htmlFor="setup-pass" className="mb-1 block text-xs font-medium text-ink-dim">Contraseña de administrador</label>
        <input id="setup-pass" className={inputCls} type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus required minLength={6} />
      </div>
      <div>
        <label htmlFor="setup-confirm" className="mb-1 block text-xs font-medium text-ink-dim">Confirmar contraseña</label>
        <input id="setup-confirm" className={inputCls} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={6} />
      </div>
      {error && <p className="text-xs font-medium text-loss" role="alert">{error}</p>}
      <Btn type="submit" className="w-full !py-2.5" disabled={busy}>
        {busy ? "Configurando…" : "Crear administrador"}
      </Btn>
    </form>
  );
}

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const canBio = isBiometricAvailable() && hasBiometricCredential();

  useEffect(() => {
    if (needsSetup()) setSetup(true);
  }, []);

  useEffect(() => {
    if (canBio && !setup) bioLogin();
  }, [canBio, setup]);

  const bioLogin = async () => {
    setBusy(true);
    setError("");
    try {
      const user = await verifyBiometric();
      const session = await login(user, "__biometric__");
      if (!session) {
        const directSession = { username: user, role: "admin", sections: "all", accounts: "all", ts: Date.now(), biometric: true };
        sessionStorage.setItem("mis-finazas-session", JSON.stringify(directSession));
        onLogin(directSession);
      } else {
        session.biometric = true;
        sessionStorage.setItem("mis-finazas-session", JSON.stringify(session));
        onLogin(session);
      }
    } catch {
      setError("Biometría cancelada. Usa usuario y contraseña.");
    }
    setBusy(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const session = await login(username, password);
    setBusy(false);
    if (!session) {
      setError("Usuario o contraseña incorrectos.");
      return;
    }
    onLogin(session);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-base-950">
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 via-base-950 to-emerald-950" aria-hidden="true" />
      <video className="absolute inset-0 size-full object-cover opacity-30" src={BG_VIDEO} autoPlay muted loop playsInline aria-hidden="true" />
      <div className="absolute inset-0 bg-base-950/40" aria-hidden="true" />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="relative z-10 w-full max-w-sm rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-xl"
      >
        <div className="mb-6 text-center">
          <p className="text-4xl" aria-hidden="true">◈</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">Mis finazas</h1>
          <p className="mt-1 text-sm text-ink-dim">Tu patrimonio, bajo control.</p>
        </div>

        {setup ? (
          <SetupForm onDone={onLogin} />
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label htmlFor="login-user" className="mb-1 block text-xs font-medium text-ink-dim">Usuario</label>
              <input id="login-user" className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
            </div>
            <div>
              <label htmlFor="login-pass" className="mb-1 block text-xs font-medium text-ink-dim">Contraseña</label>
              <input id="login-pass" className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>

            {error && <p className="text-xs font-medium text-loss" role="alert">{error}</p>}

            <Btn type="submit" className="w-full !py-2.5" disabled={busy}>
              {busy ? "Verificando…" : "Entrar"}
            </Btn>

            {canBio && (
              <Btn variant="ghost" className="w-full" onClick={bioLogin} disabled={busy}>
                🔓 Entrar con Face ID / Huella
              </Btn>
            )}
          </form>
        )}

        {!setup && (
          <p className="mt-4 text-center text-[10px] text-ink-dim/70">
            🔒 Cifrado AES-256 · Acceso por usuario y permisos
          </p>
        )}
      </motion.div>
    </div>
  );
}
