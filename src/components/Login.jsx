import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { biometricSession, hasBiometricCredential, isBiometricAvailable, login, needsSetupCloud, setupAdmin, verifyBiometric } from "../auth.js";
import { API_BASE } from "../utils.js";
import { Btn, inputCls } from "./UI.jsx";

const BG_VIDEO = "/finance-bg.mp4";

function SetupForm({ onDone }) {
  const [user, setUser] = useState("jr");
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const uname = user.trim();
    if (!uname) { setError("Escribe un nombre de usuario."); return; }
    if (pass.length < 6) { setError("Mínimo 6 caracteres."); return; }
    if (pass !== confirm) { setError("Las contraseñas no coinciden."); return; }
    setBusy(true);
    try {
      await setupAdmin(pass, uname);
      const session = await login(uname, pass);
      if (session) onDone(session);
      else setError("Error al iniciar sesión.");
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-ink-dim">Crea el usuario administrador para proteger tus datos.</p>
      <div>
        <label htmlFor="setup-user" className="mb-1 block text-xs font-medium text-ink-dim">Usuario administrador</label>
        <input id="setup-user" className={inputCls} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" autoFocus required />
      </div>
      <div>
        <label htmlFor="setup-pass" className="mb-1 block text-xs font-medium text-ink-dim">Contraseña</label>
        <input id="setup-pass" className={inputCls} type="password" value={pass} onChange={(e) => setPass(e.target.value)} required minLength={6} />
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

function RegisterForm({ onBack }) {
  const [step, setStep] = useState("request"); // "request" | "verify" | "done"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState(""); // W30-fix: código en pantalla cuando no hay email
  const [createdUsername, setCreatedUsername] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submitRequest = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${API_BASE}/api/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request", email, password }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || "Error al enviar el correo."); return; }
      if (data.devMode && data.devCode) setDevCode(String(data.devCode));
      setStep("verify");
    } catch {
      setError("Error de conexión.");
    }
    setBusy(false);
  };

  const submitVerify = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${API_BASE}/api/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", email, code }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error || "Código incorrecto."); return; }
      setCreatedUsername(data.username);
      setStep("done");
    } catch {
      setError("Error de conexión.");
    }
    setBusy(false);
  };

  if (step === "done") {
    return (
      <div className="space-y-3 text-center">
        <p className="text-2xl">✓</p>
        <p className="text-sm font-medium">Cuenta creada</p>
        <p className="text-xs text-ink-dim">Usuario: <strong>{createdUsername}</strong></p>
        <p className="text-xs text-ink-dim">Tienes acceso a las cuentas de demostración.</p>
        <Btn className="w-full !py-2.5" onClick={onBack}>Ir a iniciar sesión</Btn>
      </div>
    );
  }

  if (step === "verify") {
    return (
      <form onSubmit={submitVerify} className="space-y-3">
        {devCode ? (
          <div className="rounded-xl bg-gold/10 p-3 text-center">
            <p className="text-xs text-ink-dim">Modo demo (sin email configurado). Tu código de verificación:</p>
            <p className="mt-1 text-2xl font-bold tracking-[0.3em] tabular-nums text-gold">{devCode}</p>
          </div>
        ) : (
          <p className="text-sm text-ink-dim">Ingresa el código de 6 dígitos que enviamos a <strong>{email}</strong>.</p>
        )}
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-dim">Código de verificación</label>
          <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} required autoFocus placeholder="123456" />
        </div>
        {error && <p className="text-xs font-medium text-loss" role="alert">{error}</p>}
        <Btn type="submit" className="w-full !py-2.5" disabled={busy}>{busy ? "Verificando…" : "Verificar"}</Btn>
        <Btn variant="ghost" className="w-full" type="button" onClick={() => { setStep("request"); setError(""); }}>← Volver</Btn>
      </form>
    );
  }

  return (
    <form onSubmit={submitRequest} className="space-y-3">
      <p className="text-sm text-ink-dim">Crea una cuenta gratuita con acceso a las cuentas de demostración.</p>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-dim">Correo electrónico</label>
        <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-dim">Contraseña</label>
        <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
      </div>
      {error && <p className="text-xs font-medium text-loss" role="alert">{error}</p>}
      <Btn type="submit" className="w-full !py-2.5" disabled={busy}>{busy ? "Enviando código…" : "Enviar código de verificación"}</Btn>
      <Btn variant="ghost" className="w-full" type="button" onClick={onBack}>← Volver al login</Btn>
    </form>
  );
}

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const [checking, setChecking] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const canBio = isBiometricAvailable() && hasBiometricCredential();

  useEffect(() => {
    let alive = true;
    (async () => {
      const needs = await needsSetupCloud();
      if (alive) { setSetup(needs); setChecking(false); }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!checking && canBio && !setup) bioLogin();
  }, [checking, canBio, setup]);

  const bioLogin = async () => {
    setBusy(true);
    setError("");
    try {
      const user = await verifyBiometric();
      // WebAuthn ya validó la identidad en el dispositivo; concede la sesión con
      // los permisos REALES del usuario (o deniega si ya no existe). Sin admin fijo.
      const session = await biometricSession(user);
      if (session) {
        session.biometric = true;
        sessionStorage.setItem("mis-finazas-session", JSON.stringify(session));
        onLogin(session);
      } else {
        setError("Ese usuario ya no existe. Entra con usuario y contraseña.");
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

        {showRegister ? (
          <RegisterForm onBack={() => setShowRegister(false)} />
        ) : setup ? (
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

        {!setup && !showRegister && (
          <>
            <button
              type="button"
              onClick={() => setShowRegister(true)}
              className="mt-3 w-full text-center text-[10px] text-ink-dim/70 underline hover:text-ink-dim"
            >
              ¿No tienes cuenta? Crear cuenta de demostración
            </button>

            <button
              type="button"
              onClick={() => {
                if (!confirm("Esto borra los usuarios de este dispositivo y la biometría. Crearás un usuario nuevo. ¿Continuar?")) return;
                localStorage.removeItem('mis-finazas-users');
                sessionStorage.removeItem('mis-finazas-session');
                localStorage.removeItem('mis-finazas-session');
                localStorage.removeItem('mis-finazas-webauthn-cred'); // limpia Face ID/huella del acceso anterior
                location.reload();
              }}
              className="mt-3 w-full text-center text-[10px] text-ink-dim/60 underline hover:text-ink-dim"
            >
              ¿Olvidaste la contraseña? Resetear acceso
            </button>

            <p className="mt-4 text-center text-[10px] text-ink-dim/70">
              🔒 Cifrado AES-256 · Acceso por usuario y permisos
            </p>
          </>
        )}
      </motion.div>
    </div>
  );
}
