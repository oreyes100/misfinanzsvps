import { lazy, Suspense, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { StoreProvider, useStore } from "./store.jsx";
import { canAccess, currentSession, hasBiometricCredential, logout } from "./auth.js";
import BottomNav from "./components/BottomNav.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Login from "./components/Login.jsx";
import Manage from "./components/Manage.jsx";
import Reports from "./components/Reports.jsx";
import Settings from "./components/Settings.jsx";
import Transactions from "./components/Transactions.jsx";
import { SecurityBadge } from "./components/UI.jsx";

const Assistant = lazy(() => import("./components/Assistant.jsx"));
const Auditoria = lazy(() => import("./components/Auditoria.jsx"));
const Importar = lazy(() => import("./components/IaImport.jsx"));
const McpMenu = lazy(() => import("./components/McpMenu.jsx"));
import McpNotification from "./components/McpNotification.jsx";

const VIEWS = {
  inicio: Dashboard,
  movimientos: Transactions,
  mcp: McpMenu,
  gestion: Manage,
  reportes: Reports,
  auditoria: Auditoria,
  asistente: Assistant,
  importar: Importar,
  ajustes: Settings,
};

function Shell({ session, onLogout }) {
  const { state, sync } = useStore();
  const firstTab = Object.keys(VIEWS).find((id) => canAccess(session, id)) ?? "inicio";
  const [tab, setTab] = useState(firstTab);

  // Pull inmediato al entrar (la sesión acaba de iniciar, nube puede tener cambios de otros dispositivos)
  useEffect(() => {
    if (sync?.id && sync?.retry) sync.retry();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const View = canAccess(session, tab) ? VIEWS[tab] : null;

  const syncIcon = !sync?.id ? '' :
    sync.status === 'synced' ? '☁️' :
    sync.status === 'pulling' ? '↓' :
    sync.status === 'pushing' ? '↑' :
    sync.status === 'error' ? '⚠' : '☁';

  const syncColor = sync?.status === 'synced' ? 'text-gain' :
    sync?.status === 'error' ? 'text-loss' : 'text-ink-dim';

  return (
    <div className="mx-auto max-w-5xl px-4 pb-28 pt-5">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-accent focus:px-4 focus:py-2 focus:text-base-950"
      >
        Saltar al contenido
      </a>

      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">
          <span aria-hidden="true" className="mr-1.5">◈</span>Mis finazas
        </h1>
        <div className="flex items-center gap-2">
          <SecurityBadge biometric={hasBiometricCredential()} />
          {sync?.id && (
            <button
              onClick={() => { if (sync) sync.forcePush?.(); }}
              disabled={sync.status === 'pushing' || sync.status === 'pulling'}
              className={`text-[10px] px-1.5 py-0.5 rounded bg-white/10 ${syncColor} font-mono tabular-nums hover:bg-white/20 active:bg-white/30 transition-colors cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed`}
              title="Clic para sincronizar ahora"
            >
              {syncIcon} {sync.status}
            </button>
          )}
          <button
            type="button"
            onClick={onLogout}
            className="rounded-full bg-white/8 px-3 py-1 text-xs text-ink-dim transition hover:bg-white/15"
            title={`Sesión: ${session.username}`}
          >
            {session.username} · Salir
          </button>
        </div>
      </header>

      <main id="contenido">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <Suspense fallback={<div className="p-8 text-center text-ink-dim">Cargando…</div>}>
            {View ? <View session={session} /> : <p className="text-sm text-ink-dim">No tienes acceso a esta sección.</p>}
          </Suspense>
        </motion.div>
      </main>

      <BottomNav tab={tab} setTab={setTab} session={session} />
      <McpNotification tab={tab} onNavigate={() => setTab("mcp")} />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(currentSession());

  if (!session) return <Login onLogin={setSession} />;

  return (
    <StoreProvider>
      <Shell
        session={session}
        onLogout={() => {
          logout();
          setSession(null);
        }}
      />
    </StoreProvider>
  );
}
