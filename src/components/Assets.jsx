import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useStore } from "../store.jsx";
import { convert, fmtMoney, fmtPct } from "../utils.js";
import { Btn, Field, Glass, Modal, inputCls } from "./UI.jsx";

const CRYPTO_SYMBOLS = ["BTC", "ETH"];

function gainTone(v) {
  return v >= 0 ? "text-gain" : "text-loss";
}

/** Alta/edición de inmueble. `item` null → crear. Importes en divisa base. */
function RealEstateModal({ item, onClose }) {
  const { state, dispatch } = useStore();
  const base = state.settings.baseCurrency;
  const isNew = !item;
  const toBase = (eur) => convert(eur, "EUR", base, state.fx);
  const toEUR = (b) => convert(b, base, "EUR", state.fx);

  const [form, setForm] = useState(
    item
      ? { name: item.name, value: toBase(item.valueEUR).toFixed(0), cost: toBase(item.costBasisEUR).toFixed(0), source: item.source || "" }
      : { name: "", value: "", cost: "", source: "Valoración manual" }
  );
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setError("Ponle un nombre al inmueble.");
    const value = parseFloat(form.value);
    const cost = parseFloat(form.cost);
    if (!(value >= 0) || !(cost >= 0)) return setError("Valor y coste deben ser números válidos.");
    const payload = {
      name: form.name.trim(),
      valueEUR: Math.round(toEUR(value)),
      costBasisEUR: Math.round(toEUR(cost)),
      source: form.source.trim() || "Valoración manual",
    };
    if (isNew) dispatch({ type: "add_realestate", item: payload });
    else dispatch({ type: "update_realestate", id: item.id, patch: payload });
    onClose();
  };

  return (
    <Modal title={isNew ? "Nuevo inmueble" : `Editar «${item.name}»`} onClose={onClose} labelId="re-modal-title">
      <form className="space-y-3" onSubmit={save}>
        <Field label="Nombre">
          <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Ej.: Piso — Calle Luna 12" required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Valor de mercado (${base})`}>
            <input className={inputCls} type="number" inputMode="decimal" min="0" step="1000" value={form.value} onChange={(e) => set("value", e.target.value)} required />
          </Field>
          <Field label={`Coste de compra (${base})`}>
            <input className={inputCls} type="number" inputMode="decimal" min="0" step="1000" value={form.cost} onChange={(e) => set("cost", e.target.value)} required />
          </Field>
        </div>
        <Field label="Fuente de valoración" hint="Ej.: API Idealista, tasación, valoración manual.">
          <input className={inputCls} value={form.source} onChange={(e) => set("source", e.target.value)} />
        </Field>
        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn type="submit" onClick={save}>{isNew ? "Crear inmueble" : "Guardar cambios"}</Btn>
        </div>
      </form>
    </Modal>
  );
}

/** Alta/edición de criptoactivo. */
function CryptoModal({ item, onClose }) {
  const { state, dispatch } = useStore();
  const base = state.settings.baseCurrency;
  const isNew = !item;
  const toBase = (eur) => convert(eur, "EUR", base, state.fx);
  const toEUR = (b) => convert(b, base, "EUR", state.fx);

  const [form, setForm] = useState(
    item
      ? { symbol: item.symbol, name: item.name, qty: item.qty.toString(), cost: toBase(item.costBasisEUR).toFixed(0) }
      : { symbol: "BTC", name: "Bitcoin", qty: "", cost: "" }
  );
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = (e) => {
    e.preventDefault();
    const qty = parseFloat(form.qty);
    const cost = parseFloat(form.cost);
    if (!(qty > 0)) return setError("La cantidad debe ser mayor que cero.");
    if (!(cost >= 0)) return setError("El coste debe ser un número válido.");
    const payload = {
      symbol: form.symbol,
      name: form.symbol === "BTC" ? "Bitcoin" : "Ethereum",
      qty,
      costBasisEUR: Math.round(toEUR(cost)),
    };
    if (isNew) dispatch({ type: "add_crypto", crypto: payload });
    else dispatch({ type: "update_crypto", id: item.id, patch: payload });
    onClose();
  };

  return (
    <Modal title={isNew ? "Nuevo criptoactivo" : `Editar ${item.symbol}`} onClose={onClose} labelId="crypto-modal-title">
      <form className="space-y-3" onSubmit={save}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Moneda">
            <select className={inputCls} value={form.symbol} onChange={(e) => set("symbol", e.target.value)} disabled={!isNew}>
              {CRYPTO_SYMBOLS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Cantidad">
            <input className={inputCls} type="number" inputMode="decimal" min="0" step="0.0001" value={form.qty} onChange={(e) => set("qty", e.target.value)} required />
          </Field>
        </div>
        <Field label={`Coste de adquisición (${base})`}>
          <input className={inputCls} type="number" inputMode="decimal" min="0" step="10" value={form.cost} onChange={(e) => set("cost", e.target.value)} required />
        </Field>
        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn type="submit" onClick={save}>{isNew ? "Añadir" : "Guardar cambios"}</Btn>
        </div>
      </form>
    </Modal>
  );
}

const DEP_KINDS = { auto: "Auto", moto: "Moto", electronico: "Electrónico", mueble: "Mueble", otro: "Otro" };

/** Alta/edición de bien que se deprecia (auto, moto, …). Importes en base. */
function DepreciatingModal({ item, onClose }) {
  const { state, dispatch } = useStore();
  const base = state.settings.baseCurrency;
  const isNew = !item;
  const toBase = (eur) => convert(eur, "EUR", base, state.fx);
  const toEUR = (b) => convert(b, base, "EUR", state.fx);

  const [form, setForm] = useState(
    item
      ? { name: item.name, kind: item.kind || "auto", value: toBase(item.valueEUR).toFixed(0), cost: toBase(item.costBasisEUR).toFixed(0), depRate: ((item.depRate || 0) * 100).toFixed(0) }
      : { name: "", kind: "auto", value: "", cost: "", depRate: "15" }
  );
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setError("Ponle un nombre al bien.");
    const value = parseFloat(form.value);
    const cost = parseFloat(form.cost);
    if (!(value >= 0) || !(cost >= 0)) return setError("Valor y coste deben ser números válidos.");
    const payload = {
      name: form.name.trim(),
      kind: form.kind,
      valueEUR: Math.round(toEUR(value)),
      costBasisEUR: Math.round(toEUR(cost)),
      depRate: Math.min(100, Math.max(0, parseFloat(form.depRate) || 0)) / 100,
    };
    if (isNew) dispatch({ type: "add_depreciating", item: payload });
    else dispatch({ type: "update_depreciating", id: item.id, patch: payload });
    onClose();
  };

  return (
    <Modal title={isNew ? "Nuevo bien depreciable" : `Editar «${item.name}»`} onClose={onClose} labelId="dep-modal-title">
      <form className="space-y-3" onSubmit={save}>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Nombre">
            <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Ej.: Auto — Mazda 3" required />
          </Field>
          <Field label="Tipo">
            <select className={inputCls} value={form.kind} onChange={(e) => set("kind", e.target.value)}>
              {Object.entries(DEP_KINDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Valor actual (${base})`}>
            <input className={inputCls} type="number" inputMode="decimal" min="0" step="1000" value={form.value} onChange={(e) => set("value", e.target.value)} required />
          </Field>
          <Field label={`Coste de compra (${base})`}>
            <input className={inputCls} type="number" inputMode="decimal" min="0" step="1000" value={form.cost} onChange={(e) => set("cost", e.target.value)} required />
          </Field>
        </div>
        <Field label="Depreciación anual (%)" hint="Informativa: estima la pérdida de valor por año.">
          <input className={inputCls} type="number" inputMode="decimal" min="0" max="100" step="1" value={form.depRate} onChange={(e) => set("depRate", e.target.value)} />
        </Field>
        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn type="submit" onClick={save}>{isNew ? "Crear" : "Guardar cambios"}</Btn>
        </div>
      </form>
    </Modal>
  );
}

export default function Assets() {
  const { state, dispatch } = useStore();
  const base = state.settings.baseCurrency;
  const inBase = (eur) => convert(eur, "EUR", base, state.fx);
  const [reModal, setReModal] = useState(null); // "new" | item
  const [cryptoModal, setCryptoModal] = useState(null);
  const [depModal, setDepModal] = useState(null);
  const [gold, setGold] = useState(null); // edición inline

  const goldValue = state.assets.gold.grams * state.goldPriceEUR;
  const goldGain = goldValue - state.assets.gold.costBasisEUR;
  const reTotal = state.assets.realEstate.reduce((s, r) => s + r.valueEUR, 0);
  const depTotal = (state.assets.depreciating || []).reduce((s, d) => s + d.valueEUR, 0);

  const removeRE = (r) => {
    if (confirm(`¿Eliminar «${r.name}»?`)) dispatch({ type: "delete_realestate", id: r.id });
  };
  const removeCrypto = (c) => {
    if (confirm(`¿Eliminar ${c.symbol}?`)) dispatch({ type: "delete_crypto", id: c.id });
  };

  const saveGold = () => {
    const grams = parseFloat(gold.grams);
    const cost = parseFloat(gold.cost);
    if (grams >= 0 && cost >= 0) {
      dispatch({ type: "update_gold", patch: { grams, costBasisEUR: Math.round(convert(cost, base, "EUR", state.fx)) } });
    }
    setGold(null);
  };

  return (
    <div className="space-y-3">
      {/* ---- Inmuebles ---- */}
      <Glass aria-label="Gestión de inmuebles">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Inmuebles</h2>
            <p className="text-xs text-ink-dim">Marca con ★ el inmueble que se muestra en Inicio.</p>
          </div>
          <div className="flex items-center gap-3">
            {state.assets.realEstate.length > 0 && (
              <span className="text-sm font-bold tabular-nums">{fmtMoney(inBase(reTotal), base, { compact: true })}</span>
            )}
            <Btn onClick={() => setReModal("new")} className="!py-1.5 text-xs">+ Nuevo</Btn>
          </div>
        </div>
        <ul className="space-y-2">
          {state.assets.realEstate.map((r) => {
            const gain = (r.valueEUR - r.costBasisEUR) / r.costBasisEUR;
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => dispatch({ type: "set_featured_realestate", id: r.id })}
                  aria-pressed={!!r.featured}
                  aria-label={r.featured ? `${r.name} es el inmueble destacado` : `Destacar ${r.name} en Inicio`}
                  className={`pressable text-lg ${r.featured ? "text-gold" : "text-ink-dim/40"}`}
                  title={r.featured ? "Destacado en Inicio" : "Destacar en Inicio"}
                >
                  {r.featured ? "★" : "☆"}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-ink-dim">{r.source}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums">{fmtMoney(inBase(r.valueEUR), base, { compact: true })}</p>
                  <p className={`text-xs tabular-nums ${gainTone(gain)}`}>{fmtPct(gain)}</p>
                </div>
                <div className="flex gap-1.5">
                  <Btn variant="ghost" className="!px-2.5 !py-1.5 text-xs" onClick={() => setReModal(r)} aria-label={`Editar ${r.name}`}>✏️</Btn>
                  <Btn variant="danger" className="!px-2.5 !py-1.5 text-xs" onClick={() => removeRE(r)} aria-label={`Eliminar ${r.name}`}>🗑</Btn>
                </div>
              </li>
            );
          })}
          {!state.assets.realEstate.length && <li className="py-4 text-center text-sm text-ink-dim">Sin inmuebles.</li>}
        </ul>
      </Glass>

      {/* ---- Bienes que se deprecian (autos, motos, …) ---- */}
      <Glass aria-label="Gestión de bienes depreciables">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Bienes (autos, motos…)</h2>
            <p className="text-xs text-ink-dim">Activos que pierden valor con el tiempo.</p>
          </div>
          <div className="flex items-center gap-3">
            {(state.assets.depreciating || []).length > 0 && (
              <span className="text-sm font-bold tabular-nums">{fmtMoney(inBase(depTotal), base, { compact: true })}</span>
            )}
            <Btn onClick={() => setDepModal("new")} className="!py-1.5 text-xs">+ Nuevo</Btn>
          </div>
        </div>
        <ul className="space-y-2">
          {(state.assets.depreciating || []).map((d) => {
            const gain = (d.valueEUR - d.costBasisEUR) / d.costBasisEUR;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="text-xs text-ink-dim">{DEP_KINDS[d.kind] || d.kind} · −{((d.depRate || 0) * 100).toFixed(0)} %/año</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums">{fmtMoney(inBase(d.valueEUR), base, { compact: true })}</p>
                  <p className={`text-xs tabular-nums ${gainTone(gain)}`}>{fmtPct(gain)}</p>
                </div>
                <div className="flex gap-1.5">
                  <Btn variant="ghost" className="!px-2.5 !py-1.5 text-xs" onClick={() => setDepModal(d)} aria-label={`Editar ${d.name}`}>✏️</Btn>
                  <Btn variant="danger" className="!px-2.5 !py-1.5 text-xs" onClick={() => { if (confirm(`¿Eliminar «${d.name}»?`)) dispatch({ type: "delete_depreciating", id: d.id }); }} aria-label={`Eliminar ${d.name}`}>🗑</Btn>
                </div>
              </li>
            );
          })}
          {!(state.assets.depreciating || []).length && <li className="py-4 text-center text-sm text-ink-dim">Sin bienes registrados.</li>}
        </ul>
      </Glass>

      {/* ---- Cripto ---- */}
      <Glass aria-label="Gestión de criptoactivos">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Cripto</h2>
          <Btn onClick={() => setCryptoModal("new")} className="!py-1.5 text-xs">+ Nuevo</Btn>
        </div>
        <ul className="space-y-2">
          {state.assets.crypto.map((c) => {
            const val = c.qty * state.fx[c.symbol];
            const gain = (val - c.costBasisEUR) / c.costBasisEUR;
            return (
              <li key={c.id} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{c.name} <span className="text-ink-dim">· {c.qty} {c.symbol}</span></p>
                  <p className="text-xs text-ink-dim">Valor {fmtMoney(inBase(val), base, { compact: true })}</p>
                </div>
                <p className={`text-xs tabular-nums ${gainTone(gain)}`}>{fmtPct(gain)}</p>
                <div className="flex gap-1.5">
                  <Btn variant="ghost" className="!px-2.5 !py-1.5 text-xs" onClick={() => setCryptoModal(c)} aria-label={`Editar ${c.symbol}`}>✏️</Btn>
                  <Btn variant="danger" className="!px-2.5 !py-1.5 text-xs" onClick={() => removeCrypto(c)} aria-label={`Eliminar ${c.symbol}`}>🗑</Btn>
                </div>
              </li>
            );
          })}
          {!state.assets.crypto.length && <li className="py-4 text-center text-sm text-ink-dim">Sin criptoactivos.</li>}
        </ul>
      </Glass>

      {/* ---- Oro ---- */}
      <Glass aria-label="Gestión de oro">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gold">Oro</h2>
          {!gold && (
            <Btn variant="ghost" className="!py-1.5 text-xs" onClick={() => setGold({ grams: state.assets.gold.grams.toString(), cost: inBase(state.assets.gold.costBasisEUR).toFixed(0) })}>
              ✏️ Editar
            </Btn>
          )}
        </div>
        {!gold ? (
          <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium">{state.assets.gold.grams} g</p>
              <p className="text-xs text-ink-dim">Precio {fmtMoney(inBase(state.goldPriceEUR), base)}/g</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums">{fmtMoney(inBase(goldValue), base, { compact: true })}</p>
              <p className={`text-xs tabular-nums ${gainTone(goldGain)}`}>{fmtPct(goldGain / state.assets.gold.costBasisEUR)}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Gramos">
                <input className={inputCls} type="number" inputMode="decimal" min="0" step="1" value={gold.grams} onChange={(e) => setGold((g) => ({ ...g, grams: e.target.value }))} />
              </Field>
              <Field label={`Coste total (${base})`}>
                <input className={inputCls} type="number" inputMode="decimal" min="0" step="10" value={gold.cost} onChange={(e) => setGold((g) => ({ ...g, cost: e.target.value }))} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setGold(null)}>Cancelar</Btn>
              <Btn onClick={saveGold}>Guardar</Btn>
            </div>
          </div>
        )}
      </Glass>

      <AnimatePresence>
        {reModal && <RealEstateModal item={reModal === "new" ? null : reModal} onClose={() => setReModal(null)} />}
        {cryptoModal && <CryptoModal item={cryptoModal === "new" ? null : cryptoModal} onClose={() => setCryptoModal(null)} />}
        {depModal && <DepreciatingModal item={depModal === "new" ? null : depModal} onClose={() => setDepModal(null)} />}
      </AnimatePresence>
    </div>
  );
}
