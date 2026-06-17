import { createPortal } from "react-dom";
import { motion } from "framer-motion";

/** Tarjeta de vidrio con entrada animada. */
export function Glass({ children, className = "", as: Tag = motion.section, ...rest }) {
  return (
    <Tag
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className={`glass p-4 ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Botón principal con micro-interacción de presión (<300 ms). */
export function Btn({ children, variant = "primary", className = "", ...rest }) {
  const styles = {
    primary: "bg-accent text-base-950 font-semibold hover:brightness-110",
    ghost: "bg-white/8 text-ink hover:bg-white/14 border border-white/12",
    danger: "bg-loss/85 text-white font-semibold hover:brightness-110",
    gain: "bg-gain text-base-950 font-semibold hover:brightness-110",
  };
  return (
    <button
      type="button"
      className={`pressable rounded-xl px-4 py-2 text-sm transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Cantidad con formato condicional: verde ganancia, rojo pérdida. */
export function Money({ value, formatted, className = "" }) {
  const tone = value > 0 ? "text-gain" : value < 0 ? "text-loss" : "text-ink";
  return (
    <span className={`tabular-nums ${tone} ${className}`}>
      {value > 0 ? "+" : ""}
      {formatted}
    </span>
  );
}

/** Indicador de seguridad: cifrado + biometría (WebAuthn real). */
export function SecurityBadge({ biometric }) {
  return (
    <div
      className="flex items-center gap-2 rounded-full border border-gain/30 bg-gain/10 px-3 py-1 text-[11px] text-gain"
      role="status"
      aria-label={`Datos cifrados de extremo a extremo. Sesión ${biometric ? "verificada con biometría" : "sin biometría"}.`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 8V6a3 3 0 1 1 6 0v3H9Z" />
      </svg>
      <span>Cifrado AES-256</span>
      <span aria-hidden="true">·</span>
      <span className="flex items-center gap-1">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M7 12a5 5 0 0 1 10 0v2a7 7 0 0 1-2 5M12 12v3a4 4 0 0 0 4 4M4 8a9 9 0 0 1 16 0M9 19a8 8 0 0 1-2-5" />
        </svg>
        {biometric ? "Face ID activo" : "Biometría off"}
      </span>
    </div>
  );
}

/** Modal accesible con fondo de desenfoque. `size`: "md" (def.) | "lg" (captura ancha). */
export function Modal({ title, onClose, children, labelId, size = "md" }) {
  const width = size === "lg" ? "max-w-2xl" : "max-w-md";
  // Portal a <body>: evita que un ancestro con `transform` (motion/Glass) capture el
  // `position: fixed` y empuje el diálogo al fondo de la página. Centrado en el viewport.
  const overlay = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-base-950/60 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ y: 24, scale: 0.97 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 24, opacity: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        className={`glass max-h-[92vh] w-full ${width} overflow-y-auto p-5`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={labelId} className="text-lg font-semibold">{title}</h2>
          <Btn variant="ghost" aria-label="Cerrar diálogo" onClick={onClose} className="!px-2.5 !py-1.5">✕</Btn>
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
  return typeof document !== "undefined" ? createPortal(overlay, document.body) : overlay;
}

export function Field({ label, children, hint }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-ink-dim">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-dim/80">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-xl border border-white/12 bg-white/6 px-3 py-2 text-ink placeholder:text-ink-dim/60 focus:border-accent focus:outline-none focus-visible:outline-3";
