import { useState } from "react";
import { motion } from "framer-motion";
import { login } from "../auth.js";
import { Btn, inputCls } from "./UI.jsx";

// Video de stock libre (Pexels — gráficas financieras). Si no carga, queda el gradiente de respaldo.
const BG_VIDEO = "https://videos.pexels.com/video-files/7579577/7579577-uhd_2560_1440_25fps.mp4";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      {/* Fondo: video + gradiente de respaldo */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 via-base-950 to-emerald-950" aria-hidden="true" />
      <video
        className="absolute inset-0 size-full object-cover opacity-30"
        src={BG_VIDEO}
        autoPlay
        muted
        loop
        playsInline
        aria-hidden="true"
      />
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

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="login-user" className="mb-1 block text-xs font-medium text-ink-dim">Usuario</label>
            <input
              id="login-user"
              className={inputCls}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div>
            <label htmlFor="login-pass" className="mb-1 block text-xs font-medium text-ink-dim">Contraseña</label>
            <input
              id="login-pass"
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && <p className="text-xs font-medium text-loss" role="alert">{error}</p>}

          <Btn type="submit" className="w-full !py-2.5" disabled={busy}>
            {busy ? "Verificando…" : "Entrar"}
          </Btn>
        </form>

        <p className="mt-4 text-center text-[10px] text-ink-dim/70">
          🔒 Cifrado AES-256 · Acceso por usuario y permisos
        </p>
      </motion.div>
    </div>
  );
}
