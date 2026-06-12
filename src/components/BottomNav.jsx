import { motion } from "framer-motion";

const TABS = [
  { id: "inicio", label: "Inicio", icon: "M3 11.5 12 4l9 7.5M5 10v9h5v-5h4v5h5v-9" },
  { id: "movimientos", label: "Movs", icon: "M4 7h13m0 0-3-3m3 3-3 3M20 17H7m0 0 3-3m-3 3 3 3" },
  { id: "gestion", label: "Gestión", icon: "M4 6h16M4 6v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6M4 6l2-3h12l2 3M9 11h6" },
  { id: "asistente", label: "IA", icon: "M12 3a7 7 0 0 1 7 7c0 2.5-1.3 4.3-2.7 5.7L16 21h-8l-.3-5.3C6.3 14.3 5 12.5 5 10a7 7 0 0 1 7-7Zm-2 7h.01M14 10h.01" },
  { id: "ajustes", label: "Ajustes", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8 4a8 8 0 0 1-.2 1.8l2 1.6-2 3.4-2.4-1a8 8 0 0 1-3 1.8L14 22h-4l-.4-2.4a8 8 0 0 1-3-1.8l-2.4 1-2-3.4 2-1.6A8 8 0 0 1 4 12c0-.6.1-1.2.2-1.8l-2-1.6 2-3.4 2.4 1a8 8 0 0 1 3-1.8L10 2h4l.4 2.4a8 8 0 0 1 3 1.8l2.4-1 2 3.4-2 1.6c.1.6.2 1.2.2 1.8Z" },
];

export default function BottomNav({ tab, setTab }) {
  return (
    <nav aria-label="Navegación principal" className="fixed inset-x-0 bottom-0 z-40 pb-[env(safe-area-inset-bottom)]">
      <div className="glass mx-auto mb-3 flex w-[min(28rem,calc(100%-1.5rem))] justify-around !rounded-2xl p-1.5">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={active ? "page" : undefined}
              className="pressable relative flex min-w-13 flex-col items-center gap-0.5 rounded-xl px-2.5 py-1.5 text-[11px] font-medium"
            >
              {active && (
                <motion.span
                  layoutId="nav-pill"
                  transition={{ duration: 0.25, ease: "easeOut" }}
                  className="absolute inset-0 rounded-xl bg-accent/20 ring-1 ring-accent/40"
                  aria-hidden="true"
                />
              )}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={active ? "text-accent-soft" : "text-ink-dim"}>
                <path d={t.icon} />
              </svg>
              <span className={active ? "text-accent-soft" : "text-ink-dim"}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
