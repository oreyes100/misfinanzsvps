import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store.jsx";
import { catColor, categorize, convert, fmtMoney, groupedAccounts, todayISO, uid } from "../utils.js";
import { aiExtract, matchAccount, ocrImage, parseReceipt, parseTransfer } from "../ocr.js";
import { Btn, Field, Modal, Money, inputCls } from "./UI.jsx";

const aliasNorm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Conmutador Gasto / Ingreso / Transferencia compartido entre los modales de alta. */
export function TypeTabs({ value, onChange }) {
  const opts = [["expense", "Gasto"], ["income", "Ingreso"], ["transfer", "Transferencia"]];
  return (
    <div className="flex gap-2" role="radiogroup" aria-label="Tipo de movimiento">
      {opts.map(([v, l]) => {
        const active = value === v;
        const tone = v === "expense" ? "border-loss/60 bg-loss/15 text-loss"
          : v === "income" ? "border-gain/60 bg-gain/15 text-gain"
          : "border-accent/60 bg-accent/15 text-accent-soft";
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(v)}
            className={`pressable flex-1 rounded-xl border px-3 py-2 text-sm font-medium transition-colors duration-150 ${
              active ? tone : "border-white/12 bg-white/6 text-ink-dim"
            }`}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

/** Transferencia entre cuentas con paso de confirmación explícito + OCR de captura. */
export function TransferModal({ onClose, preset, tabs }) {
  const { state, dispatch } = useStore();
  const [fromId, setFromId] = useState(preset?.fromId || state.accounts[0]?.id);
  const [toId, setToId] = useState(preset?.toId || state.accounts[1]?.id);
  const [amount, setAmount] = useState(preset?.amount || "");
  const [date, setDate] = useState(preset?.date || todayISO());
  const [notes, setNotes] = useState(preset?.notes || "");
  const [step, setStep] = useState("form"); // form | confirm | done
  const [error, setError] = useState("");
  const [ocr, setOcr] = useState(null); // { busy, progress, fromHint, toHint, note }
  const ocrHints = useRef({ fromHint: null, toHint: null }); // para aprender al ejecutar
  const fileRef = useRef(null);

  const from = state.accounts.find((a) => a.id === fromId);
  const to = state.accounts.find((a) => a.id === toId);
  const amt = parseFloat(amount) || 0;
  const credited = from && to && from.currency !== to.currency
    ? convert(amt, from.currency, to.currency, state.fx)
    : amt;

  const scanTransfer = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setOcr({ busy: true, progress: 0 });
    try {
      let r;
      if (state.settings.geminiKey) {
        setOcr({ busy: true, ai: true });
        const ai = await aiExtract(file, state.settings.geminiKey, { categories: state.categories, accounts: state.accounts });
        const t = ai.transfer || {};
        r = {
          amount: t.amount || ai.total || null,
          from: matchAccount(t.from, state.accounts, state.transferAliases),
          to: matchAccount(t.to, state.accounts, state.transferAliases),
          fromHint: t.from || null,
          toHint: t.to || null,
        };
        r.confident = !!(r.amount && r.from && r.to && r.from.id !== r.to.id);
      } else {
        const text = await ocrImage(file, (p) => setOcr((o) => ({ ...o, progress: p })));
        r = parseTransfer(text, state.accounts, state.transferAliases);
      }
      ocrHints.current = { fromHint: r.fromHint, toHint: r.toHint };
      if (r.amount) setAmount(String(r.amount));
      if (r.from) setFromId(r.from.id);
      if (r.to) setToId(r.to.id);
      if (r.confident) {
        setOcr({ busy: false, note: "✓ Reconocido. Revisa y confirma." });
      } else {
        const faltan = [!r.amount && "importe", !r.from && "cuenta origen", !r.to && "cuenta destino"].filter(Boolean);
        setOcr({ busy: false, note: `Reconocido parcialmente. Confirma manualmente: ${faltan.join(", ") || "datos"}. Aprenderé para la próxima.` });
      }
    } catch (err) {
      setOcr({ busy: false, note: `No pude leer la imagen${err?.message ? ` (${err.message})` : ""}. Introduce los datos a mano.` });
    }
  };

  const review = () => {
    if (!from || !to) return setError("Selecciona ambas cuentas.");
    if (fromId === toId) return setError("La cuenta de origen y destino no pueden ser la misma.");
    if (amt <= 0) return setError("Introduce un importe mayor que cero.");
    setError("");
    setStep("confirm");
  };

  const execute = () => {
    dispatch({ type: "transfer", fromId, toId, amount: amt, date, notes: notes.trim() || undefined });
    // Aprender: asociar el texto OCR de origen/destino a las cuentas elegidas.
    const aliases = {};
    if (ocrHints.current.fromHint) aliases[aliasNorm(ocrHints.current.fromHint)] = fromId;
    if (ocrHints.current.toHint) aliases[aliasNorm(ocrHints.current.toHint)] = toId;
    if (Object.keys(aliases).length) dispatch({ type: "learn_transfer_aliases", aliases });
    setStep("done");
    setTimeout(onClose, 1100);
  };

  return (
    <Modal title="Transferencia entre cuentas" onClose={onClose} labelId="transfer-title">
      {step === "form" && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); review(); }}>
          {tabs}
          <input ref={fileRef} type="file" accept="image/*" className="sr-only" aria-hidden="true" tabIndex={-1} onChange={scanTransfer} />
          <Btn variant="ghost" className="w-full" onClick={() => fileRef.current?.click()} disabled={ocr?.busy}>
            {ocr?.busy
              ? ocr.ai ? "🧠 Analizando con IA…" : `Leyendo captura… ${Math.round((ocr.progress || 0) * 100)}%`
              : `📷 Subir captura de transferencia ${state.settings.geminiKey ? "(IA)" : "(OCR)"}`}
          </Btn>
          {ocr?.note && <p className="rounded-lg bg-white/6 px-3 py-2 text-xs text-ink-dim" aria-live="polite">{ocr.note}</p>}

          <Field label="Desde">
            <select className={inputCls} value={fromId} onChange={(e) => setFromId(e.target.value)}>
              {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
                <optgroup key={type} label={label}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} — {fmtMoney(a.balance, a.currency)}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Hacia">
            <select className={inputCls} value={toId} onChange={(e) => setToId(e.target.value)}>
              {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
                <optgroup key={type} label={label}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Importe (${from?.currency || "EUR"})`}>
              <input
                className={inputCls}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0,00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </Field>
            <Field label="Fecha">
              <input className={inputCls} type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
          </div>
          {from && to && from.currency !== to.currency && (
            <p className="text-xs text-ink-dim">Conversión en tiempo real: recibirás ≈ {fmtMoney(credited, to.currency)}</p>
          )}
          <Field label="Notas (opcional — de qué o por qué)">
            <textarea
              className={`${inputCls} min-h-[52px] resize-y`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ej: pago alquiler, devolución préstamo, regalo cumpleaños..."
            />
          </Field>
          {error && <p role="alert" className="text-sm text-loss">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
            <Btn type="submit" onClick={review}>Revisar transferencia</Btn>
          </div>
        </form>
      )}

      {step === "confirm" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-accent/30 bg-accent/10 p-4 text-sm">
            <p className="mb-2 font-medium text-accent-soft">Confirma los datos antes de ejecutar:</p>
            <dl className="space-y-1.5">
              <div className="flex justify-between"><dt className="text-ink-dim">Origen</dt><dd>{from.name} ({from.currency})</dd></div>
              <div className="flex justify-between"><dt className="text-ink-dim">Destino</dt><dd>{to.name} ({to.currency})</dd></div>
              <div className="flex justify-between"><dt className="text-ink-dim">Envías</dt><dd className="font-semibold">{fmtMoney(amt, from.currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-dim">Destino recibe</dt><dd className="font-semibold">{fmtMoney(credited, to.currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-dim">Fecha</dt><dd>{date}</dd></div>
              {notes.trim() && <div className="flex justify-between"><dt className="text-ink-dim">Notas</dt><dd className="max-w-[55%] text-right break-words">{notes.trim()}</dd></div>}
            </dl>
          </div>
          <p className="text-xs text-ink-dim">Esta acción se registra al instante y queda reflejada en ambas cuentas.</p>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setStep("form")}>Volver</Btn>
            <Btn variant="gain" onClick={execute}>Confirmar y ejecutar</Btn>
          </div>
        </div>
      )}

      {step === "done" && (
        <motion.p
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="py-6 text-center text-lg font-semibold text-gain"
          role="status"
        >
          ✓ Transferencia completada
        </motion.p>
      )}
    </Modal>
  );
}

/** Alta y edición de gasto/ingreso con categorización IA y OCR de recibos (demo). `tx` → editar. */
export function TransactionModal({ onClose, preset, tx }) {
  const { state, dispatch, sync } = useStore();
  const isEdit = !!tx;
  const [desc, setDesc] = useState(tx?.description || preset?.description || "");
  const [amount, setAmount] = useState(tx ? Math.abs(tx.amount).toString() : preset?.amount?.toString() || "");
  const [sign, setSign] = useState(tx ? (tx.amount < 0 ? "expense" : "income") : preset?.sign || "expense");
  const [date, setDate] = useState(tx?.date || todayISO());
  const initialAccount = (tx?.accountId && state.accounts.some((a) => a.id === tx.accountId))
    ? tx.accountId
    : (state.accounts[0]?.id || tx?.accountId || '');
  const [accountId, setAccountId] = useState(initialAccount);
  const accountExists = !!state.accounts.find((a) => a.id === accountId);
  const isOrphanTx = !!tx && !state.accounts.some((a) => a.id === tx.accountId);
  const [catOverride, setCatOverride] = useState(tx?.category || "");
  const [subcat, setSubcat] = useState(tx?.subcategory || "");
  const [notes, setNotes] = useState(tx?.notes || preset?.notes || "");
  const [ocr, setOcr] = useState(null); // { busy, progress, ai, note }
  const [receipt, setReceipt] = useState(null); // { merchant, total, date, items } tras escanear
  const [statement, setStatement] = useState(null); // { merchant, rows } captura bancaria con varios movimientos
  const [counterpartId, setCounterpartId] = useState(tx?.counterpartId || "");
  const [formError, setFormError] = useState("");
  const fileRef = useRef(null);

  const ai = categorize(desc, state.categories);
  const suggested = sign === "income" ? "Ingresos" : ai.category;
  const category = catOverride || suggested;
  const catOptions = state.categories.filter((c) => c.type === (sign === "income" ? "income" : "expense"));
  const activeCat = state.categories.find((c) => c.name === category);
  const subcatOptions = activeCat?.subcategories || [];

  const acctCurrency = state.accounts.find((a) => a.id === accountId)?.currency || tx?.currency || "EUR";

  // Aplica el resultado simple (un solo gasto) al formulario.
  const applySingle = (merchant, total, when) => {
    setDesc(merchant || "Gasto escaneado");
    setAmount(total ? String(total) : "");
    setSign("expense");
    if (when && when <= todayISO()) setDate(when);
    setOcr({ busy: false, note: `Detectado: ${merchant} · ${total ? fmtMoney(total, acctCurrency) : "revisa el importe"}${when ? ` · ${when}` : ""}` });
  };

  const scanReceipt = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setOcr({ busy: true, progress: 0 });
    try {
      if (state.settings.geminiKey) {
        // Motor IA (Gemini): distingue ticket / estado de cuenta / transferencia.
        setOcr({ busy: true, ai: true });
        const r = await aiExtract(file, state.settings.geminiKey, { categories: state.categories, accounts: state.accounts });
        const when = r.date && r.date <= todayISO() ? r.date : null;

        if (r.type === "statement" && r.movements?.length) {
          const otherAcc = state.accounts.find((a) => a.id !== accountId)?.id || accountId;
          setStatement({
            merchant: r.merchant || "Estado de cuenta",
            rows: r.movements.map((m) => ({
              id: uid(),
              date: m.date && m.date <= todayISO() ? m.date : todayISO(),
              dateSure: !!m.date,
              description: m.description || "Movimiento",
              amount: Math.abs(m.amount) || "",
              kind: m.isTransfer ? (m.direction === "in" ? "transf-in" : "transf-out") : m.direction === "in" ? "ingreso" : "gasto",
              category: m.category || (m.direction === "in" ? "Ingresos" : "Otros"),
              catSure: !!m.category,
              counterId: otherAcc,
              include: true,
            })),
          });
          setOcr(null);
        } else if (r.type === "receipt" && r.items?.length > 1) {
          // Cada ítem reconocido es una fila editable (corregir nombre/importe/categoría).
          const items = r.items.map((it) => {
            const cat = state.categoryAliases[aliasNorm(it.name)] || it.category || "Otros";
            return {
              id: uid(),
              name: it.name || "Artículo",
              amount: Math.abs(it.amount || 0) || "",
              category: cat,
              subcategory: it.subcategory || null,
              origCategory: cat,
              include: true,
            };
          });
          if (when) setDate(when);
          setReceipt({ merchant: r.merchant || "Recibo", total: r.total || null, date: when, items });
          setOcr(null);
        } else {
          applySingle(r.merchant, r.total || r.transfer?.amount, when);
        }
      } else {
        // OCR local (Tesseract). Para mejor precisión, configura Gemini en Ajustes.
        const text = await ocrImage(file, (p) => setOcr((o) => ({ ...o, progress: p })));
        const parsed = parseReceipt(text, state.categories, state.categoryAliases);
        const when = parsed.date && parsed.date <= todayISO() ? parsed.date : null;
        if (parsed.items.length > 1) {
          const items = parsed.items.map((it) => ({
            id: uid(),
            name: it.name,
            amount: it.amount,
            category: it.category,
            subcategory: it.subcategory,
            origCategory: it.category,
            include: true,
          }));
          if (when) setDate(when);
          setReceipt({ merchant: parsed.merchant, total: parsed.total, date: when, items });
          setOcr(null);
        } else {
          applySingle(parsed.merchant, parsed.total, when);
        }
      }
    } catch (err) {
      setOcr({ busy: false, note: `No pude leer la imagen${err?.message ? ` (${err.message})` : ""}. Introduce los datos a mano.` });
    }
  };

  // Registrar todos los movimientos del estado de cuenta.
  const registerStatement = () => {
    const acc = state.accounts.find((a) => a.id === accountId);
    for (const r of statement.rows) {
      const amt = Math.abs(parseFloat(r.amount));
      if (!r.include || !(amt > 0)) continue;
      if (r.kind === "transf-in" || r.kind === "transf-out") {
        const counter = state.accounts.find((a) => a.id === r.counterId);
        if (!counter || counter.id === accountId) continue;
        const [fromAcc, toAcc] = r.kind === "transf-in" ? [counter, acc] : [acc, counter];
        // Doble registro: cargo en origen y abono en destino.
        dispatch({ type: "add_transaction", tx: { description: `Transferencia a ${toAcc.name}`, amount: -amt, currency: fromAcc.currency, accountId: fromAcc.id, category: "Transferencia", date: r.date } });
        dispatch({ type: "add_transaction", tx: { description: `Transferencia desde ${fromAcc.name}`, amount: amt, currency: toAcc.currency, accountId: toAcc.id, category: "Transferencia", date: r.date } });
      } else {
        dispatch({
          type: "add_transaction",
          tx: {
            description: r.description,
            amount: r.kind === "ingreso" ? amt : -amt,
            currency: acc.currency,
            accountId,
            category: r.category,
            date: r.date,
          },
        });
      }
    }
    onClose();
  };

  const updateRow = (id, patch) =>
    setStatement((s) => ({ ...s, rows: s.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));

  const updateItem = (id, patch) =>
    setReceipt((rc) => ({ ...rc, items: rc.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));

  // Registrar el recibo: agrupa los ítems incluidos por categoría/subcategoría
  // (una transacción por grupo) y aprende de cada corrección de categoría.
  const registerReceipt = () => {
    const acc = state.accounts.find((a) => a.id === accountId);
    const date0 = date;
    const rows = receipt.items.filter((it) => it.include && parseFloat(it.amount) > 0);
    const map = new Map();
    for (const it of rows) {
      const key = `${it.category}|${it.subcategory || ""}`;
      const g = map.get(key) || { category: it.category, subcategory: it.subcategory || null, total: 0 };
      g.total = Math.round((g.total + Math.abs(parseFloat(it.amount))) * 100) / 100;
      map.set(key, g);
    }
    for (const g of map.values()) {
      dispatch({
        type: "add_transaction",
        tx: {
          description: `${receipt.merchant}${g.subcategory ? ` — ${g.subcategory}` : ""}`,
          amount: -Math.abs(g.total),
          currency: acc.currency,
          accountId,
          category: g.category,
          subcategory: g.subcategory || null,
          date: date0,
        },
      });
    }
    // Aprender: cada ítem cuya categoría el usuario cambió → texto → categoría.
    const aliases = {};
    for (const it of rows) {
      if (it.category && it.category !== it.origCategory) aliases[aliasNorm(it.name)] = it.category;
    }
    if (Object.keys(aliases).length) dispatch({ type: "learn_category_aliases", aliases });
    onClose();
  };

  const save = (e) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!desc) { setFormError("Escribe una descripción."); return; }
    if (!amt) { setFormError("Introduce un importe válido mayor que cero."); return; }
    setFormError("");
    const acc = state.accounts.find((a) => a.id === accountId);
    const useCurrency = acc?.currency || tx?.currency || "EUR";
    const payload = {
      description: desc,
      amount: sign === "expense" ? -Math.abs(amt) : Math.abs(amt),
      currency: useCurrency,
      accountId: accountId || (tx?.accountId || ''),
      category,
      subcategory: subcat || null,
      date,
      notes: notes.trim() || undefined,
    };
    if (category === "Transferencia" && counterpartId) payload.counterpartId = counterpartId;
    if (isEdit) dispatch({ type: "update_transaction", id: tx.id, patch: payload });
    else dispatch({ type: "add_transaction", tx: payload });
    onClose();
  };

  const remove = () => {
    const msg = isOrphanTx
      ? `¿Eliminar «${tx.description}»? (transacción huérfana de cuenta borrada)`
      : `¿Eliminar «${tx.description}»? El saldo de la cuenta se reajustará.`;
    if (confirm(msg)) {
      dispatch({ type: "delete_transaction", id: tx.id });
      // Force immediate cloud push so aggressive pulls don't restore the deleted tx
      if (sync && typeof sync.forcePush === "function" && sync.id) {
        setTimeout(() => { try { sync.forcePush(); } catch (e) {} }, 60);
      }
      onClose();
    }
  };

  // Conmutador de tipo: Gasto / Ingreso / Transferencia.
  const handleType = (v) => {
    if (v === "transfer") { setSign("transfer"); return; }
    setSign(v);
    setCatOverride("");
  };

  // En modo transferencia se delega al modal de transferencia (mismo conmutador arriba).
  // Solo al crear (no al editar un movimiento existente).
  if (!isEdit && sign === "transfer") {
    return <TransferModal onClose={onClose} tabs={<TypeTabs value="transfer" onChange={handleType} />} />;
  }

  if (statement) {
    const expenseCats = state.categories.filter((c) => c.type === "expense");
    const incomeCats = state.categories.filter((c) => c.type === "income");
    const valid = statement.rows.filter((r) => r.include && parseFloat(r.amount) > 0);
    return (
      <Modal title={`Movimientos · ${statement.merchant}`} onClose={onClose} labelId="tx-title" size="lg">
        <div className="space-y-3">
          <Field label="Cuenta de estos movimientos" hint="Tarjeta o cuenta de la captura.">
            <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
                <optgroup key={type} label={label}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>

          <p className="text-xs text-ink-dim">
            Revisa cada movimiento. Las transferencias se registran doble (cargo en origen, abono en destino).
            Los campos dudosos vienen marcados para que los confirmes.
          </p>

          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {statement.rows.map((r) => {
              const isTransfer = r.kind === "transf-in" || r.kind === "transf-out";
              const cats = r.kind === "ingreso" ? incomeCats : expenseCats;
              return (
                <li key={r.id} className={`space-y-2 rounded-xl p-2.5 ${r.include ? "bg-white/5" : "bg-white/5 opacity-40"}`}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) => updateRow(r.id, { include: e.target.checked })}
                      aria-label={`Incluir ${r.description}`}
                      className="size-4 accent-[var(--color-accent)]"
                    />
                    <input
                      className={`${inputCls} flex-1 !py-1 text-sm`}
                      value={r.description}
                      onChange={(e) => updateRow(r.id, { description: e.target.value })}
                      aria-label="Descripción"
                    />
                    <input
                      className={`${inputCls} !w-24 !py-1 text-right text-sm`}
                      type="number" min="0" step="0.01" inputMode="decimal"
                      value={r.amount}
                      onChange={(e) => updateRow(r.id, { amount: e.target.value })}
                      aria-label="Importe"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs">
                      <span className="sr-only">Fecha</span>
                      <input
                        className={`${inputCls} !w-34 !py-1 text-xs ${!r.dateSure ? "!border-gold/60" : ""}`}
                        type="date" max={todayISO()}
                        value={r.date}
                        onChange={(e) => updateRow(r.id, { date: e.target.value, dateSure: true })}
                        title={!r.dateSure ? "Fecha no detectada: confírmala" : undefined}
                      />
                    </label>
                    <select
                      className={`${inputCls} !w-32 !py-1 text-xs`}
                      value={r.kind}
                      onChange={(e) => updateRow(r.id, { kind: e.target.value })}
                      aria-label="Tipo de movimiento"
                    >
                      <option value="gasto">Gasto</option>
                      <option value="ingreso">Ingreso</option>
                      <option value="transf-in">Transf. recibida</option>
                      <option value="transf-out">Transf. enviada</option>
                    </select>
                    {isTransfer ? (
                      <select
                        className={`${inputCls} !w-36 !py-1 text-xs !border-gold/60`}
                        value={r.counterId}
                        onChange={(e) => updateRow(r.id, { counterId: e.target.value })}
                        aria-label={r.kind === "transf-in" ? "Cuenta de origen" : "Cuenta de destino"}
                        title={r.kind === "transf-in" ? "¿De qué cuenta salió?" : "¿A qué cuenta fue?"}
                      >
                        {groupedAccounts(state.accounts.filter((a) => a.id !== accountId)).map(({ type, label, accounts }) => (
                          <optgroup key={type} label={label}>
                            {accounts.map((a) => <option key={a.id} value={a.id}>{r.kind === "transf-in" ? "desde" : "hacia"} {a.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    ) : (
                      <select
                        className={`${inputCls} !w-36 !py-1 text-xs ${!r.catSure ? "!border-gold/60" : ""}`}
                        value={r.category}
                        onChange={(e) => updateRow(r.id, { category: e.target.value, catSure: true })}
                        aria-label="Categoría"
                        title={!r.catSure ? "Categoría no clara: confírmala" : undefined}
                      >
                        {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                        {!cats.some((c) => c.name === r.category) && <option value={r.category}>{r.category}</option>}
                      </select>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="ghost" onClick={() => setStatement(null)}>Descartar</Btn>
            <Btn onClick={registerStatement} disabled={!valid.length}>
              Registrar {valid.length} movimiento{valid.length === 1 ? "" : "s"}
            </Btn>
          </div>
        </div>
      </Modal>
    );
  }

  if (receipt) {
    const expenseCats = state.categories.filter((c) => c.type === "expense");
    const included = receipt.items.filter((it) => it.include && parseFloat(it.amount) > 0);
    const sumIncluded = included.reduce((s, it) => s + Math.abs(parseFloat(it.amount) || 0), 0);
    const groupCount = new Set(included.map((it) => `${it.category}|${it.subcategory || ""}`)).size;
    return (
      <Modal title="Recibo escaneado" onClose={onClose} labelId="tx-title" size="lg">
        <div className="space-y-3">
          <p className="text-sm">
            <strong>{receipt.merchant}</strong> · {included.length} artículo{included.length === 1 ? "" : "s"} · suma {fmtMoney(sumIncluded, acctCurrency)}
            {receipt.total ? <span className="text-ink-dim"> (total detectado {fmtMoney(receipt.total, acctCurrency)})</span> : null}.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Fecha del recibo">
              <input className={inputCls} type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Cuenta de cargo">
              <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
                  <optgroup key={type} label={label}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
          </div>

          <p className="text-xs text-ink-dim">
            Corrige nombre, importe o categoría de cada artículo (la IA puede equivocarse). Aprenderé tus correcciones de
            categoría para la próxima. Al registrar se agrupa por categoría en {groupCount} movimiento{groupCount === 1 ? "" : "s"}.
          </p>

          <ul className="max-h-[48vh] space-y-2 overflow-y-auto pr-1">
            {receipt.items.map((it) => (
              <li key={it.id} className={`flex flex-wrap items-center gap-2 rounded-xl p-2.5 ${it.include ? "bg-white/5" : "bg-white/5 opacity-40"}`}>
                <input
                  type="checkbox"
                  checked={it.include}
                  onChange={(e) => updateItem(it.id, { include: e.target.checked })}
                  aria-label={`Incluir ${it.name}`}
                  className="size-4 accent-[var(--color-accent)]"
                />
                <span className="size-2.5 rounded-full" style={{ background: catColor(it.category, state.categories) }} aria-hidden="true" />
                <input
                  className={`${inputCls} min-w-32 flex-1 !py-1 text-sm`}
                  value={it.name}
                  onChange={(e) => updateItem(it.id, { name: e.target.value })}
                  aria-label="Artículo"
                />
                <input
                  className={`${inputCls} !w-24 !py-1 text-right text-sm`}
                  type="number" min="0" step="0.01" inputMode="decimal"
                  value={it.amount}
                  onChange={(e) => updateItem(it.id, { amount: e.target.value })}
                  aria-label="Importe"
                />
                <select
                  className={`${inputCls} !w-32 !py-1 text-xs ${it.category !== it.origCategory ? "!border-accent/60" : ""}`}
                  value={it.category}
                  onChange={(e) => updateItem(it.id, { category: e.target.value, subcategory: null })}
                  aria-label="Categoría"
                  title={it.category !== it.origCategory ? "Corregido — se aprenderá" : undefined}
                >
                  {expenseCats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                  {!expenseCats.some((c) => c.name === it.category) && <option value={it.category}>{it.category}</option>}
                </select>
                {(state.categories.find((c) => c.name === it.category)?.subcategories || []).length > 0 && (
                  <select
                    className={`${inputCls} !w-32 !py-1 text-xs`}
                    value={it.subcategory || ""}
                    onChange={(e) => updateItem(it.id, { subcategory: e.target.value || null })}
                    aria-label="Subcategoría"
                  >
                    <option value="">—</option>
                    {(state.categories.find((c) => c.name === it.category)?.subcategories || []).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>

          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="ghost" onClick={() => setReceipt(null)}>Volver</Btn>
            <Btn onClick={registerReceipt} disabled={!included.length}>
              Registrar {groupCount} movimiento{groupCount === 1 ? "" : "s"}
            </Btn>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={isEdit ? "Editar movimiento" : "Nuevo movimiento"} onClose={onClose} labelId="tx-title">
      <form className="space-y-3" onSubmit={save}>
        {isEdit ? (
          <div className="flex gap-2" role="radiogroup" aria-label="Tipo de movimiento">
            {[["expense", "Gasto"], ["income", "Ingreso"]].map(([v, l]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={sign === v}
                onClick={() => { setSign(v); setCatOverride(""); }}
                className={`pressable flex-1 rounded-xl border px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                  sign === v
                    ? v === "expense" ? "border-loss/60 bg-loss/15 text-loss" : "border-gain/60 bg-gain/15 text-gain"
                    : "border-white/12 bg-white/6 text-ink-dim"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        ) : (
          <TypeTabs value={sign} onChange={handleType} />
        )}

        {isOrphanTx && (
          <div className="rounded-lg border border-loss/50 bg-loss/10 px-3 py-2 text-xs text-loss" role="alert">
            ⚠️ Transacción huérfana: la cuenta original fue eliminada. Puedes eliminarla o reasignarla a una cuenta existente al guardar.
          </div>
        )}

        <Field label="Descripción">
          <input className={inputCls} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ej.: Dominos Pizza" required />
        </Field>

        {desc && !catOverride && (
          <AnimatePresence>
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 text-xs text-ink-dim"
              aria-live="polite"
            >
              <span className="inline-block size-2 rounded-full" style={{ background: catColor(category, state.categories) }} aria-hidden="true" />
              IA sugiere: <strong className="text-ink">{category}</strong>
              {sign === "expense" && <span>({Math.round(ai.confidence * 100)} % confianza)</span>}
            </motion.p>
          </AnimatePresence>
        )}

        <div className={`grid gap-3 ${subcatOptions.length ? "grid-cols-2" : ""}`}>
          <Field label="Categoría" hint={catOverride ? "Selección manual." : "Sugerida por la IA; puedes cambiarla."}>
            <select className={inputCls} value={category} onChange={(e) => { setCatOverride(e.target.value); setSubcat(""); }}>
              {catOptions.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              {!catOptions.some((c) => c.name === category) && <option value={category}>{category}</option>}
            </select>
          </Field>
          {subcatOptions.length > 0 && (
            <Field label="Subcategoría">
              <select className={inputCls} value={subcat} onChange={(e) => setSubcat(e.target.value)}>
                <option value="">— Sin especificar —</option>
                {subcatOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Importe">
            <input className={inputCls} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <div>
            <Field label="Cuenta">
              <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
                  <optgroup key={type} label={label}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
          </div>
          {isEdit && category === "Transferencia" && (
            <Field label={tx?.amount < 0 ? "Cuenta destino →" : "Cuenta origen ←"}>
              <select className={inputCls} value={counterpartId || ""} onChange={(e) => setCounterpartId(e.target.value)}>
                {counterpartId ? (
                  groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
                    <optgroup key={type} label={label}>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </optgroup>
                  ))
                ) : (
                  <option value="">— Sin especificar —</option>
                )}
              </select>
            </Field>
          )}
        </div>

        <Field label="Fecha">
          <input className={inputCls} type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} required />
        </Field>

        <input ref={fileRef} type="file" accept="image/*" className="sr-only" aria-hidden="true" tabIndex={-1} onChange={scanReceipt} />
        <Btn variant="ghost" className="w-full" onClick={() => fileRef.current?.click()} disabled={ocr?.busy}>
          {ocr?.busy
            ? ocr.ai ? "🧠 Analizando con IA…" : `Escaneando recibo… ${Math.round((ocr.progress || 0) * 100)}%`
            : `📷 Escanear recibo o captura ${state.settings.geminiKey ? "(IA)" : "(OCR)"}`}
        </Btn>
        {ocr?.note && <p className="rounded-lg bg-white/6 px-3 py-2 text-xs text-ink-dim" aria-live="polite">{ocr.note}</p>}

        {formError && <p role="alert" className="text-xs font-medium text-loss">{formError}</p>}
        <div className="flex items-center gap-2 pt-1">
          {isEdit && (
            <Btn variant="danger" onClick={remove} aria-label={`Eliminar movimiento ${tx.description}`}>🗑 Eliminar</Btn>
          )}
          <div className="ml-auto flex gap-2">
            <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
            <Btn type="submit" onClick={save}>{isEdit ? "Guardar cambios" : "Guardar"}</Btn>
          </div>
        </div>
      </form>
    </Modal>
  );
}
