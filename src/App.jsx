import { useState } from "react";
import { motion } from "framer-motion";
import { StoreProvider, useStore } from "./store.jsx";
import { canAccess, currentSession, logout } from "./auth.js";
import Assistant from "./components/Assistant.jsx";
import BottomNav from "./components/BottomNav.jsx";
import Congregacion from "./components/Congregacion.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Login from "./components/Login.jsx";
import Manage from "./components/Manage.jsx";
import Reports from "./components/Reports.jsx";
import Settings from "./components/Settings.jsx";
import Transactions from "./components/Transactions.jsx";
import { SecurityBadge } from "./components/UI.jsx";

const VIEWS = {
  inicio: Dashboard,
  movimientos: Transactions,
  gestion: Manage,
  reportes: Reports,
  asistente: Assistant,
  congregacion: Congregacion,
  ajustes: Settings,
};

function Shell({ session, onLogout }) {
  const { state } = useStore();
  const firstTab = Object.keys(VIEWS).find((id) => canAccess(session, id)) ?? "inicio";
  const [tab, setTab] = useState(firstTab);
  const View = canAccess(session, tab) ? VIEWS[tab] : null;

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
          <SecurityBadge biometric={state.settings.biometric} />
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
          {View ? <View session={session} /> : <p className="text-sm text-ink-dim">No tienes acceso a esta sección.</p>}
        </motion.div>
      </main>

      <BottomNav tab={tab} setTab={setTab} session={session} />
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
