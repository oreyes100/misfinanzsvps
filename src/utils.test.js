import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BASE_FX, CURRENCIES, CURRENCY_SYMBOL,
  toEUR, convert, fmtMoney, fmtPct,
  categorize, categorizeSemanticAsync, catColor, DEFAULT_CATEGORIES,
  ACCOUNT_TYPES, sortedAccounts, groupedAccounts,
  parseIntent, todayISO, uid,
} from "./utils";

describe("utils · toEUR", () => {
  it("convierte USD a EUR", () => {
    expect(toEUR(100, "USD", BASE_FX)).toBeCloseTo(92, 2);
  });
  it("EUR a EUR es 1:1", () => {
    expect(toEUR(100, "EUR", BASE_FX)).toBe(100);
  });
  it("moneda desconocida devuelve el valor original", () => {
    expect(toEUR(100, "XYZ", BASE_FX)).toBe(100);
  });
});

describe("utils · convert", () => {
  it("convierte USD a EUR", () => {
    expect(convert(100, "USD", "EUR", BASE_FX)).toBeCloseTo(92, 2);
  });
  it("convierte EUR a USD", () => {
    expect(convert(92, "EUR", "USD", BASE_FX)).toBeCloseTo(100, 2);
  });
  it("misma divisa devuelve igual", () => {
    expect(convert(100, "EUR", "EUR", BASE_FX)).toBe(100);
  });
});

describe("utils · fmtMoney", () => {
  it("formatea EUR con simbolo €", () => {
    const s = fmtMoney(12345.6, "EUR");
    expect(s).toContain("12.345");
    expect(s).toContain("€");
  });
  it("formatea USD con simbolo $", () => {
    const s = fmtMoney(12345.6, "USD");
    expect(s).toContain("12,345");
    expect(s).toContain("$");
  });
  it("formatea BTC con 5 decimales", () => {
    const s = fmtMoney(0.08234, "BTC");
    expect(s).toContain("0.08234");
    expect(s).toContain("BTC");
  });
  it("modo compacto sin decimales", () => {
    const s = fmtMoney(1234.56, "EUR", { compact: true });
    expect(s).not.toContain("34");
  });
});

describe("utils · fmtPct", () => {
  it("positivo con signo +", () => {
    expect(fmtPct(0.05)).toBe("+5.00 %");
  });
  it("negativo con signo -", () => {
    expect(fmtPct(-0.03)).toBe("-3.00 %");
  });
  it("cero sin signo +", () => {
    expect(fmtPct(0)).toBe("0.00 %");
  });
});

describe("utils · categorize", () => {
  it('clasifica Netflix como Suscripciones', () => {
    expect(categorize("Netflix").category).toBe("Suscripciones");
  });
  it('clasifica Mercadona como Supermercado', () => {
    expect(categorize("Mercadona").category).toBe("Supermercado");
  });
  it('clasifica Uber como Transporte', () => {
    expect(categorize("Uber").category).toBe("Transporte");
  });
  it('default Otros para texto sin coincidencia', () => {
    expect(categorize("Compra misteriosa xyz123").category).toBe("Otros");
  });
  it("confidence > 0 cuando hay match", () => {
    expect(categorize("Netflix").confidence).toBeGreaterThan(0.5);
  });
  it("confidence = 0.3 sin match", () => {
    expect(categorize("xyz123abc").confidence).toBeCloseTo(0.3, 1);
  });
  it("respeta categorias personalizadas", () => {
    const custom = [{ id: "x", name: "Custom", keywords: ["test"], color: "#fff", type: "expense" }];
    expect(categorize("test algo", custom).category).toBe("Custom");
  });
});

describe("utils · categorizeSemanticAsync (Top of Mind A)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("cae a reglas si el backend no responde", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const r = await categorizeSemanticAsync("Netflix");
    expect(r.category).toBe("Suscripciones"); // reglas
  });

  it("cae a reglas si el backend devuelve semantic:false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ category: "Otros", confidence: 0.3, semantic: false }),
    }));
    const r = await categorizeSemanticAsync("Uber");
    expect(r.category).toBe("Transporte"); // reglas
  });

  it("usa el resultado semántico del backend", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ category: "Comida", confidence: 0.87, semantic: true }),
    }));
    const r = await categorizeSemanticAsync("Taquería El Fogoncito");
    expect(r.category).toBe("Comida");
    expect(r.confidence).toBeCloseTo(0.87, 2);
  });

  it("devuelve Otros sin descripción (sin llamar al backend)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await categorizeSemanticAsync("");
    expect(r.category).toBe("Otros");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("utils · catColor", () => {
  it("devuelve color de categoria existente", () => {
    expect(catColor("Comida")).toBe("#ff8a5c");
  });
  it("devuelve color default para categoria inexistente", () => {
    expect(catColor("NoExiste")).toBe("#7a8db3");
  });
});

describe("utils · sortedAccounts", () => {
  it("ordena por tipo y luego alfabeticamente", () => {
    const accounts = [
      { id: "1", name: "Z", type: "savings", currency: "EUR" },
      { id: "2", name: "A", type: "checking", currency: "EUR" },
      { id: "3", name: "B", type: "checking", currency: "EUR" },
    ];
    const sorted = sortedAccounts(accounts);
    expect(sorted[0].name).toBe("A");
    expect(sorted[1].name).toBe("B");
    expect(sorted[2].name).toBe("Z");
  });
});

describe("utils · groupedAccounts", () => {
  it("agrupa por tipo en orden canonico", () => {
    const accounts = [
      { id: "1", name: "Corriente", type: "checking", currency: "EUR" },
      { id: "2", name: "Ahorro", type: "savings", currency: "EUR" },
      { id: "3", name: "Visa", type: "credit", currency: "EUR" },
    ];
    const groups = groupedAccounts(accounts);
    expect(groups[0].type).toBe("checking");
    expect(groups[1].type).toBe("savings");
    expect(groups[2].type).toBe("credit");
  });
  it("no crea grupos vacios", () => {
    const accounts = [{ id: "1", name: "Ahorro", type: "savings", currency: "EUR" }];
    const groups = groupedAccounts(accounts);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("savings");
  });
});

describe("utils · parseIntent", () => {
  it("parsea gasto simple", () => {
    const intent = parseIntent("gaste 50 en comida");
    expect(intent).toBeTruthy();
    expect(intent.type).toBe("expense");
    expect(intent.amount).toBe(50);
  });
  it("parsea transferencia", () => {
    const intent = parseIntent("transfiere 200 de cuenta Corriente a cuenta Ahorro");
    expect(intent.type).toBe("transfer");
    expect(intent.amount).toBe(200);
  });
  it("parsea set_limit", () => {
    const intent = parseIntent("cambia el limite a 1500");
    expect(intent.type).toBe("set_limit");
    expect(intent.amount).toBe(1500);
  });
  it("parsea ingreso", () => {
    const intent = parseIntent("ingreso de 3000 nomina");
    expect(intent).toBeTruthy();
    expect(intent.amount).toBe(3000);
  });
  it("devuelve unknown para texto sin intencion reconocible", () => {
    const intent = parseIntent("hola como estas");
    expect(intent.type).toBe("unknown");
  });
  it("parsea cantidad en palabras", () => {
    const intent = parseIntent("gaste veinte en cine");
    expect(intent.amount).toBe(20);
  });
  it("detecta divisa USD", () => {
    const intent = parseIntent("gaste 50 dolares en comida");
    expect(intent.currency).toBe("USD");
  });
  it("detecta divisa EUR", () => {
    const intent = parseIntent("gaste 50 euros");
    expect(intent.currency).toBe("EUR");
  });
});

describe("utils · todayISO", () => {
  it("devuelve fecha en formato ISO", () => {
    const today = todayISO();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("utils · uid", () => {
  it("genera IDs unicos", () => {
    const a = uid();
    const b = uid();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(5);
  });
});

describe("utils · constantes", () => {
  it("CURRENCIES incluye las monedas base", () => {
    expect(CURRENCIES).toContain("EUR");
    expect(CURRENCIES).toContain("USD");
    expect(CURRENCIES).toContain("MXN");
    expect(CURRENCIES).toContain("BTC");
  });
  it("CURRENCY_SYMBOL tiene simbolos correctos", () => {
    expect(CURRENCY_SYMBOL.EUR).toBe("€");
    expect(CURRENCY_SYMBOL.USD).toBe("$");
    expect(CURRENCY_SYMBOL.BTC).toBe("₿");
  });
  it("ACCOUNT_TYPES incluye tipos esperados", () => {
    expect(ACCOUNT_TYPES.checking).toBe("Corriente");
    expect(ACCOUNT_TYPES.savings).toBe("Ahorro");
    expect(ACCOUNT_TYPES.credit).toBe("Tarjeta de crédito");
  });
  it("DEFAULT_CATEGORIES tiene categorias de sistema", () => {
    const sys = DEFAULT_CATEGORIES.filter((c) => c.system);
    expect(sys.length).toBeGreaterThan(0);
    expect(sys.some((c) => c.name === "Intereses")).toBe(true);
    expect(sys.some((c) => c.name === "Transferencia")).toBe(true);
    expect(sys.some((c) => c.name === "Otros")).toBe(true);
  });
});
