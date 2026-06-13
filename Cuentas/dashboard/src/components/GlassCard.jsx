import { motion } from 'framer-motion';

/**
 * Contenedor base Glassmorphism 2.0. Las micro-interacciones usan solo
 * transform/opacity (compositor) para no disparar layout recalculation.
 */
export default function GlassCard({ as = 'section', className = '', children, ...rest }) {
  const Tag = motion[as] ?? motion.section;
  return (
    <Tag
      className={`glass p-5 md:p-6 ${className}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardTitle({ icon: Icon, children, id }) {
  return (
    <h2 id={id} className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-dim">
      {Icon && <Icon aria-hidden="true" className="size-4 text-accent" />}
      {children}
    </h2>
  );
}
