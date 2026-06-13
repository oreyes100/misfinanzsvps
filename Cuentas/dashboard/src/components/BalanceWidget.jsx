import { Wallet, TrendingUp, TrendingDown, ShieldCheck } from 'lucide-react';
import GlassCard, { CardTitle } from './GlassCard.jsx';
import { fmtMoney, fmtPct } from '../lib/format.js';

function Metric({ label, value, delta }) {
  const up = delta >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <div className="rounded-xl bg-surface-2/60 p-3">
      <p className="text-xs text-ink-dim">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{fmtMoney(value)}</p>
      <p
        className={`mt-0.5 flex items-center gap-1 text-xs font-medium ${up ? 'text-up' : 'text-down'}`}
        aria-label={`${label}: ${up ? 'sube' : 'baja'} ${fmtPct(delta)} respecto al mes anterior`}
      >
        <Icon aria-hidden="true" className="size-3.5" />
        {fmtPct(delta)}
      </p>
    </div>
  );
}

export default function BalanceWidget({ data }) {
  return (
    <GlassCard className="col-span-12 md:col-span-7 xl:col-span-5 xl:row-span-2" aria-labelledby="balance-title">
      <div className="flex items-start justify-between">
        <CardTitle id="balance-title" icon={Wallet}>Balance total</CardTitle>
        {/* Señal visual de confianza: estado de verificación de la sesión */}
        <span className="flex items-center gap-1.5 rounded-full border border-up/30 bg-up/10 px-2.5 py-1 text-xs font-medium text-up">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          Sesión verificada
        </span>
      </div>

      <p className="text-4xl font-bold tracking-tight tabular-nums md:text-5xl">
        {fmtMoney(data.total)}
      </p>
      <p className={`mt-2 flex items-center gap-1.5 text-sm font-medium ${data.deltaMes >= 0 ? 'text-up' : 'text-down'}`}>
        {data.deltaMes >= 0
          ? <TrendingUp aria-hidden="true" className="size-4" />
          : <TrendingDown aria-hidden="true" className="size-4" />}
        {fmtPct(data.deltaMes)} este mes
      </p>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric label="Ingresos" value={data.ingresos} delta={data.deltaIngresos} />
        <Metric label="Gastos" value={data.gastos} delta={data.deltaGastos} />
        <Metric label="Ahorro neto" value={data.ahorro} delta={data.deltaAhorro} />
      </div>
    </GlassCard>
  );
}
