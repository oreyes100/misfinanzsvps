import { useState } from "react";
import { motion } from "framer-motion";
import { StoreProvider, useStore } from "./store.jsx";
import Assistant from "./components/Assistant.jsx";
import BottomNav from "./components/BottomNav.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Manage from "./components/Manage.jsx";
import Settings from "./components/Settings.jsx";
import Transactions from "./components/Transactions.jsx";
import { SecurityBadge } from "./components/UI.jsx";

const VIEWS = {
  inicio: Dashboard,
  movimientos: Transactions,
  gestion: Manage,
  asistente: Assistant,
  ajustes: Settings,
};

function Shell() {
  const { state } = useStore();
  const [tab, setTab] = useState("inicio");
  const View = VIEWS[tab];

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
        <SecurityBadge biometric={state.settings.biometric} />
      </header>

      <main id="contenido">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <View />
        </motion.div>
      </main>

      <BottomNav tab={tab} setTab={setTab} />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
