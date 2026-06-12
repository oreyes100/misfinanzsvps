import { useState } from "react";
import { motion } from "framer-motion";
import Accounts from "./Accounts.jsx";
import Assets from "./Assets.jsx";
import Categories from "./Categories.jsx";

const SECTIONS = [
  { id: "cuentas", label: "Cuentas", view: Accounts },
  { id: "activos", label: "Activos", view: Assets },
  { id: "categorias", label: "Categorías", view: Categories },
];

export default function Manage() {
  const [section, setSection] = useState("cuentas");
  const View = SECTIONS.find((s) => s.id === section).view;

  return (
    <div className="space-y-3">
      <div className="glass flex gap-1 !rounded-2xl p-1" role="tablist" aria-label="Secciones de gestión">
        {SECTIONS.map((s) => {
          const active = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSection(s.id)}
              className="pressable relative flex-1 rounded-xl px-3 py-2 text-sm font-medium"
            >
              {active && (
                <motion.span
                  layoutId="manage-pill"
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className="absolute inset-0 rounded-xl bg-accent/20 ring-1 ring-accent/40"
                  aria-hidden="true"
                />
              )}
              <span className={active ? "relative text-accent-soft" : "relative text-ink-dim"}>{s.label}</span>
            </button>
          );
        })}
      </div>
      <View />
    </div>
  );
}
