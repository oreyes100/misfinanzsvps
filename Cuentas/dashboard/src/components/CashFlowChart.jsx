import { Activity } from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import GlassCard, { CardTitle } from './GlassCard.jsx';
import { fmtMoney } from '../lib/format.js';

const tooltipStyle = {
  background: '#16233b',
  border: '1px solid rgb(255 255 255 / 0.1)',
  borderRadius: '0.75rem',
  color: '#e7eef9',
};

export default function CashFlowChart({ data }) {
  const last = data[data.length - 1];
  return (
    <GlassCard className="col-span-12 xl:col-span-7 xl:row-span-2" aria-labelledby="flujo-title">
      <CardTitle id="flujo-title" icon={Activity}>Flujo de caja — últimos 12 meses</CardTitle>

      {/* Resumen textual del gráfico para lectores de pantalla (WCAG 1.1.1) */}
      <p className="sr-only">
        Gráfico de líneas con ingresos y gastos mensuales. Último mes ({last.mes}):
        ingresos {fmtMoney(last.ingresos)}, gastos {fmtMoney(last.gastos)}.
      </p>

      <div className="h-64 md:h-72" role="img" aria-label="Tendencia de ingresos y gastos de los últimos 12 meses">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="gIngresos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gGastos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#fb8a9b" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#fb8a9b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgb(255 255 255 / 0.06)" vertical={false} />
            <XAxis dataKey="mes" stroke="#9fb0c9" fontSize={12} tickLine={false} axisLine={false} />
            <YAxis
              stroke="#9fb0c9" fontSize={12} tickLine={false} axisLine={false} width={52}
              tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [fmtMoney(v), name]} />
            <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
            <Area type="monotone" dataKey="ingresos" name="Ingresos" stroke="#34d399"
              strokeWidth={2} fill="url(#gIngresos)" isAnimationActive={false} />
            <Area type="monotone" dataKey="gastos" name="Gastos" stroke="#fb8a9b"
              strokeWidth={2} fill="url(#gGastos)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </GlassCard>
  );
}
