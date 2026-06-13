import { LineChart, TrendingUp, TrendingDown } from 'lucide-react';
import GlassCard, { CardTitle } from './GlassCard.jsx';
import { fmtMoney, fmtPct } from '../lib/format.js';

const riskColor = {
  Bajo: 'text-up border-up/30 bg-up/10',
  Medio: 'text-accent border-accent/30 bg-accent/10',
  Alto: 'text-down border-down/30 bg-down/10',
};

export default function InvestmentsTable({ positions }) {
  return (
    <GlassCard className="col-span-12 xl:col-span-7" aria-labelledby="inversiones-title">
      <CardTitle id="inversiones-title" icon={LineChart}>Inversiones</CardTitle>

      {/* Scroll vertical con encabezado sticky para no perder contexto;
          overflow-x para pantallas estrechas. */}
      <div className="max-h-72 overflow-auto rounded-xl border border-glass-line" tabIndex={0}
        role="region" aria-labelledby="inversiones-title">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <caption className="sr-only">
            Posiciones de inversión con valor actual, rendimiento y nivel de riesgo
          </caption>
          <thead className="sticky top-0 z-10 bg-surface-3/95 backdrop-blur">
            <tr className="text-left text-xs uppercase tracking-wider text-ink-dim">
              <th scope="col" className="px-4 py-3 font-semibold">Activo</th>
              <th scope="col" className="px-4 py-3 font-semibold">Tipo</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Valor</th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">Rendimiento</th>
              <th scope="col" className="px-4 py-3 font-semibold">Riesgo</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const up = p.rendimiento >= 0;
              const Icon = up ? TrendingUp : TrendingDown;
              return (
                <tr key={p.id} className="border-t border-glass-line/60 transition-colors duration-150 hover:bg-white/[0.04]">
                  <th scope="row" className="px-4 py-3 text-left font-medium">{p.nombre}</th>
                  <td className="px-4 py-3 text-ink-dim">{p.tipo}</td>
                  {/* Formato tabular para precisión numérica */}
                  <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(p.valor)}</td>
                  <td
                    className={`px-4 py-3 text-right font-medium tabular-nums ${up ? 'text-up' : 'text-down'}`}
                    aria-label={`${up ? 'Ganancia' : 'Pérdida'} de ${fmtPct(p.rendimiento)}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Icon aria-hidden="true" className="size-3.5" />
                      {fmtPct(p.rendimiento)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${riskColor[p.riesgo]}`}>
                      {p.riesgo}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </GlassCard>
  );
}
