import { lazy, Suspense } from 'react';
import { Landmark, Fingerprint } from 'lucide-react';
import BalanceWidget from './components/BalanceWidget.jsx';
import InvestmentsTable from './components/InvestmentsTable.jsx';
import AIAssistant from './components/AIAssistant.jsx';

/* Recharts pesa ~500 kB minificado: se separa del bundle inicial y se
   carga en paralelo mientras el resto del dashboard ya es interactivo. */
const CashFlowChart = lazy(() => import('./components/CashFlowChart.jsx'));

function ChartSkeleton() {
  return (
    <section
      className="glass col-span-12 animate-pulse p-5 md:p-6 xl:col-span-7 xl:row-span-2"
      aria-label="Cargando gráfico de flujo de caja"
      role="status"
    >
      <div className="mb-4 h-4 w-56 rounded bg-white/10" />
      <div className="h-64 rounded-xl bg-white/5 md:h-72" />
    </section>
  );
}

/* Datos de demostración. Para datos reales, reemplazar por fetch('/api/...')
   — el proxy de Vite ya apunta a la API Express en el puerto 3002. */
const balance = {
  total: 128450.32,
  deltaMes: 4.2,
  ingresos: 18200, deltaIngresos: 6.1,
  gastos: 11340, deltaGastos: -2.4,
  ahorro: 6860, deltaAhorro: 12.8,
};

const flujo = [
  { mes: 'Jul', ingresos: 14200, gastos: 11900 },
  { mes: 'Ago', ingresos: 14800, gastos: 12300 },
  { mes: 'Sep', ingresos: 15100, gastos: 11700 },
  { mes: 'Oct', ingresos: 15600, gastos: 12800 },
  { mes: 'Nov', ingresos: 16200, gastos: 13100 },
  { mes: 'Dic', ingresos: 17800, gastos: 14600 },
  { mes: 'Ene', ingresos: 16400, gastos: 11900 },
  { mes: 'Feb', ingresos: 16900, gastos: 11500 },
  { mes: 'Mar', ingresos: 17300, gastos: 12200 },
  { mes: 'Abr', ingresos: 17600, gastos: 11800 },
  { mes: 'May', ingresos: 17900, gastos: 11600 },
  { mes: 'Jun', ingresos: 18200, gastos: 11340 },
];

const posiciones = [
  { id: 1, nombre: 'Fondo indexado S&P 500', tipo: 'Renta variable', valor: 42300.5, rendimiento: 11.2, riesgo: 'Medio' },
  { id: 2, nombre: 'Bonos del Tesoro 10a', tipo: 'Renta fija', valor: 28900.0, rendimiento: 3.8, riesgo: 'Bajo' },
  { id: 3, nombre: 'ETF Mercados emergentes', tipo: 'Renta variable', valor: 15400.75, rendimiento: -4.6, riesgo: 'Alto' },
  { id: 4, nombre: 'Fondo monetario', tipo: 'Liquidez', valor: 21100.0, rendimiento: 4.9, riesgo: 'Bajo' },
  { id: 5, nombre: 'ETF Tecnología global', tipo: 'Renta variable', valor: 12749.07, rendimiento: 17.4, riesgo: 'Alto' },
  { id: 6, nombre: 'Fondo inmobiliario (REIT)', tipo: 'Inmobiliario', valor: 8000.0, rendimiento: -1.2, riesgo: 'Medio' },
];

const propuestas = [
  {
    id: 'a1',
    kind: 'transferencia',
    titulo: 'Programar transferencia de $2,500 a Ahorro',
    detalle: 'Detecté un excedente recurrente de liquidez a fin de mes. Mover $2,500 el día 28 mantiene tu colchón de 3 meses intacto.',
    status: 'pendiente',
    preview: { antes: 21100, despues: 23600, nota: 'Saldo del fondo monetario tras la transferencia del día 28. Reversible antes de la fecha de ejecución.' },
  },
  {
    id: 'a2',
    kind: 'limite',
    titulo: 'Ajustar límite de gasto en suscripciones a $180/mes',
    detalle: 'El gasto en suscripciones subió 23% en 3 meses. Un límite con alerta evita cargos no revisados.',
    status: 'pendiente',
    preview: { antes: 234, despues: 180, nota: 'Recibirás una alerta al alcanzar el 80% del límite; ningún cargo se bloquea automáticamente.' },
  },
];

export default function App() {
  return (
    <>
      {/* Enlace de salto al contenido (WCAG 2.4.1) */}
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-surface"
      >
        Saltar al contenido principal
      </a>

      <header className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 pt-6 md:px-8">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-accent/15">
            <Landmark aria-hidden="true" className="size-5 text-accent" />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Panel financiero</h1>
            <p className="text-xs text-ink-dim">Vista de CFO · jueves, 11 de junio de 2026</p>
          </div>
        </div>
        {/* Estado de verificación biométrica visible: comunica confianza */}
        <p className="flex items-center gap-2 rounded-full border border-glass-line bg-surface-2/60 px-3 py-1.5 text-xs font-medium text-ink-dim">
          <Fingerprint aria-hidden="true" className="size-4 text-up" />
          Biometría activa
        </p>
      </header>

      {/* Bento Grid asimétrico: balance 5/12 alto, flujo 7/12 alto,
          asistente 5/12, tabla 7/12 — jerarquía visual por tamaño y posición. */}
      <main id="contenido" className="mx-auto grid max-w-7xl grid-cols-12 gap-5 px-4 py-6 md:px-8">
        <BalanceWidget data={balance} />
        <Suspense fallback={<ChartSkeleton />}>
          <CashFlowChart data={flujo} />
        </Suspense>
        <AIAssistant
          insight="Tu ahorro neto creció 12.8% este mes. Si mantienes el ritmo, alcanzarás tu meta anual 2 meses antes. Hay dos optimizaciones disponibles que requieren tu aprobación."
          proposals={propuestas}
        />
        <InvestmentsTable positions={posiciones} />
      </main>
    </>
  );
}
