# Learned Rules — Mis Finanzas
> Reglas candidatas. Tras 3+ sesiones sin violación → `.claude/rules/`. Tras 5+, 0 violaciones → `CLAUDE.md`.
> Format: regla | trigger | verify | sesiones-ok

---

## Candidatas Activas

**L1 — vault_lint.py debe pasar antes de close**
- Trigger: se encontraron Wiki/ y MOCs/ vacíos que causaban lint warnings
- Verify: `python scripts/vault_lint.py 2>&1 | grep -c ERROR` debe ser 0
- Sesiones OK: 1

**L2 — Assistant.jsx: pre-flight para todos los action types**
- Trigger: solo "transfer" valida saldo; "expense" asume siempre accounts[0] sin verificar que existe
- Verify: el intent.type "expense" con state.accounts.length === 0 no debe lanzar error
- Sesiones OK: 0 (pendiente fix — ver Fase 3)

**L3 — Framer Motion variants deben tener `exit` definido**
- Trigger: componentes sin `exit` causan flicker al desmontar
- Verify: grep -r "variants=" src/ | grep -v exit — resultado vacío es correcto
- Sesiones OK: 0 (no verificado aún)

**L4 — No usar `Math.random()` directo en tick_prices para producción**
- Trigger: seed no determinista = imposible reproducir bugs de simulación de mercado
- Verify: revisar si tick_prices usa seeded random o Math.random() puro
- Sesiones OK: 0 (no verificado aún)

---

## Graduadas a .claude/rules/

*(ver verified-patterns.md — P1 a P9)*

---

## Descartadas

*(ninguna aún)*
