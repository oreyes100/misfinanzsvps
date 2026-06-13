import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, Sparkles, Eye, Check, X, ArrowRightLeft, Gauge } from 'lucide-react';
import GlassCard, { CardTitle } from './GlassCard.jsx';
import { fmtMoney } from '../lib/format.js';

const iconByKind = { transferencia: ArrowRightLeft, limite: Gauge };

/**
 * Asistente de IA agéntica: propone acciones pero NUNCA las ejecuta solo.
 * Cada acción ofrece previsualización del efecto y requiere aprobación
 * explícita del usuario (human-in-the-loop).
 */
export default function AIAssistant({ insight, proposals: initial }) {
  const [proposals, setProposals] = useState(initial);
  const [previewId, setPreviewId] = useState(null);

  const resolve = (id, status) => {
    setProposals((ps) => ps.map((p) => (p.id === id ? { ...p, status } : p)));
    if (previewId === id) setPreviewId(null);
  };

  return (
    <GlassCard className="col-span-12 md:col-span-5 xl:col-span-5" aria-labelledby="ia-title">
      <CardTitle id="ia-title" icon={Bot}>Asistente IA</CardTitle>

      <div className="flex items-start gap-3 rounded-xl bg-surface-2/60 p-3">
        <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
        <p className="text-sm leading-relaxed text-ink-dim">{insight}</p>
      </div>

      <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
        Acciones propuestas
      </h3>

      <ul className="space-y-3" aria-live="polite">
        {proposals.map((p) => {
          const Icon = iconByKind[p.kind] ?? Sparkles;
          const open = previewId === p.id;
          return (
            <li key={p.id} className="rounded-xl border border-glass-line bg-surface-2/40 p-3">
              <div className="flex items-start gap-3">
                <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{p.titulo}</p>
                  <p className="mt-0.5 text-xs text-ink-dim">{p.detalle}</p>
                </div>
              </div>

              {p.status === 'pendiente' ? (
                <>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                      onClick={() => setPreviewId(open ? null : p.id)}
                      aria-expanded={open}
                      aria-controls={`preview-${p.id}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-glass-line px-3 py-1.5 text-xs font-medium transition-colors duration-150 hover:bg-white/10"
                    >
                      <Eye aria-hidden="true" className="size-3.5" />
                      {open ? 'Ocultar vista previa' : 'Previsualizar'}
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                      onClick={() => resolve(p.id, 'aprobada')}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-up/15 px-3 py-1.5 text-xs font-semibold text-up transition-colors duration-150 hover:bg-up/25"
                    >
                      <Check aria-hidden="true" className="size-3.5" />
                      Aprobar
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                      onClick={() => resolve(p.id, 'rechazada')}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-down/15 px-3 py-1.5 text-xs font-semibold text-down transition-colors duration-150 hover:bg-down/25"
                    >
                      <X aria-hidden="true" className="size-3.5" />
                      Rechazar
                    </motion.button>
                  </div>

                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div
                        id={`preview-${p.id}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="mt-3 rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs"
                      >
                        <p className="font-semibold text-accent">Vista previa del efecto</p>
                        <dl className="mt-2 grid grid-cols-2 gap-2 tabular-nums">
                          <div>
                            <dt className="text-ink-dim">Antes</dt>
                            <dd className="font-medium">{fmtMoney(p.preview.antes)}</dd>
                          </div>
                          <div>
                            <dt className="text-ink-dim">Después</dt>
                            <dd className="font-medium">{fmtMoney(p.preview.despues)}</dd>
                          </div>
                        </dl>
                        <p className="mt-2 text-ink-dim">{p.preview.nota}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              ) : (
                <p
                  role="status"
                  className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                    p.status === 'aprobada' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
                  }`}
                >
                  {p.status === 'aprobada'
                    ? <><Check aria-hidden="true" className="size-3.5" /> Aprobada — programada</>
                    : <><X aria-hidden="true" className="size-3.5" /> Rechazada</>}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}
