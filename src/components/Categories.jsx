import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useStore } from "../store.jsx";
import { Btn, Field, Glass, Modal, inputCls } from "./UI.jsx";

/** Alta/edición de categoría. `category` null → crear. */
function CategoryModal({ category, onClose }) {
  const { state, dispatch } = useStore();
  const isNew = !category;
  const [form, setForm] = useState(
    category
      ? { ...category, keywords: (category.keywords || []).join(", ") }
      : { name: "", type: "expense", color: "#5b8cff", keywords: "" }
  );
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return setError("Ponle un nombre a la categoría.");
    const clash = state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== category?.id);
    if (clash) return setError(`Ya existe una categoría «${clash.name}».`);
    const payload = {
      name,
      type: form.type,
      color: form.color,
      keywords: form.keywords.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean),
    };
    if (isNew) dispatch({ type: "add_category", category: payload });
    else dispatch({ type: "update_category", id: category.id, patch: payload });
    onClose();
  };

  return (
    <Modal title={isNew ? "Nueva categoría" : `Editar «${category.name}»`} onClose={onClose} labelId="category-modal-title">
      <form className="space-y-3" onSubmit={save}>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Nombre">
            <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Ej.: Mascotas" required />
          </Field>
          <Field label="Color">
            <input
              type="color"
              className="h-[42px] w-14 cursor-pointer rounded-xl border border-white/12 bg-white/6 p-1"
              value={form.color}
              onChange={(e) => set("color", e.target.value)}
              aria-label="Color de la categoría"
            />
          </Field>
        </div>

        <Field label="Tipo">
          <select className={inputCls} value={form.type} onChange={(e) => set("type", e.target.value)} disabled={category?.system}>
            <option value="expense">Gasto</option>
            <option value="income">Ingreso</option>
          </select>
        </Field>

        <Field
          label="Palabras clave para la IA (separadas por comas)"
          hint="La categorización automática asigna esta categoría cuando la descripción contiene alguna de estas palabras."
        >
          <textarea
            className={`${inputCls} min-h-20 resize-y`}
            value={form.keywords}
            onChange={(e) => set("keywords", e.target.value)}
            placeholder="ej.: veterinario, pienso, kiwoko"
          />
        </Field>

        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn type="submit" onClick={save}>{isNew ? "Crear categoría" : "Guardar cambios"}</Btn>
        </div>
      </form>
    </Modal>
  );
}

function CategoryList({ title, items, onEdit, onDelete }) {
  return (
    <section aria-label={`Categorías de ${title.toLowerCase()}`}>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-dim">{title}</h3>
      <ul className="space-y-1.5">
        {items.map((c) => (
          <li key={c.id} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2">
            <span className="size-3.5 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {c.name}
                {c.system && <span className="ml-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-ink-dim">sistema</span>}
              </p>
              {c.keywords?.length > 0 && (
                <p className="truncate text-xs text-ink-dim">{c.keywords.slice(0, 5).join(" · ")}{c.keywords.length > 5 ? " …" : ""}</p>
              )}
            </div>
            <Btn variant="ghost" className="!px-2.5 !py-1.5 text-xs" onClick={() => onEdit(c)} aria-label={`Editar categoría ${c.name}`}>✏️</Btn>
            {!c.system && (
              <Btn variant="danger" className="!px-2.5 !py-1.5 text-xs" onClick={() => onDelete(c)} aria-label={`Eliminar categoría ${c.name}`}>🗑</Btn>
            )}
          </li>
        ))}
        {!items.length && <li className="py-3 text-center text-xs text-ink-dim">Ninguna todavía.</li>}
      </ul>
    </section>
  );
}

export default function Categories() {
  const { state, dispatch } = useStore();
  const [modal, setModal] = useState(null); // "new" | category

  const expenses = state.categories.filter((c) => c.type === "expense");
  const incomes = state.categories.filter((c) => c.type === "income");
  const system = state.categories.filter((c) => c.type === "system");

  const remove = (c) => {
    if (confirm(`¿Eliminar la categoría «${c.name}»? Sus movimientos pasarán a «Otros».`)) {
      dispatch({ type: "delete_category", id: c.id });
    }
  };

  return (
    <Glass aria-label="Gestión de categorías">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Categorías</h2>
          <p className="text-xs text-ink-dim">La IA usa las palabras clave para categorizar automáticamente.</p>
        </div>
        <Btn onClick={() => setModal("new")} className="!py-1.5 text-xs">+ Nueva categoría</Btn>
      </div>

      <div className="space-y-4">
        <CategoryList title="Gastos" items={expenses} onEdit={setModal} onDelete={remove} />
        <CategoryList title="Ingresos" items={incomes} onEdit={setModal} onDelete={remove} />
        {system.length > 0 && <CategoryList title="Sistema" items={system} onEdit={setModal} onDelete={remove} />}
      </div>

      <AnimatePresence>
        {modal && <CategoryModal category={modal === "new" ? null : modal} onClose={() => setModal(null)} />}
      </AnimatePresence>
    </Glass>
  );
}
