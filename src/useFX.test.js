// useFX.test.js — Tests de la conversión de oro (Top of Mind B) y helpers de FX.

import { describe, it, expect } from "vitest";
import { goldUsdPerOzToEurPerGram, TROY_OZ_GRAMS } from "./useFX.js";

describe("goldUsdPerOzToEurPerGram", () => {
  it("convierte USD/onza troy → EUR/gramo", () => {
    // 2500 USD/oz a USD=1.1 por EUR: 2500/31.1035/1.1 ≈ 73.06
    expect(goldUsdPerOzToEurPerGram(2500, 1.1)).toBeCloseTo(2500 / TROY_OZ_GRAMS / 1.1, 2);
  });

  it("redondea a 2 decimales", () => {
    const r = goldUsdPerOzToEurPerGram(2500, 1.1);
    expect(Math.abs(Math.round(r * 100) - r * 100)).toBeLessThan(1e-9);
  });

  it("devuelve null sin precio", () => {
    expect(goldUsdPerOzToEurPerGram(null, 1.1)).toBeNull();
    expect(goldUsdPerOzToEurPerGram(undefined, 1.1)).toBeNull();
    expect(goldUsdPerOzToEurPerGram(0, 1.1)).toBeNull();
  });

  it("devuelve null sin tasa EUR", () => {
    expect(goldUsdPerOzToEurPerGram(2500, 0)).toBeNull();
    expect(goldUsdPerOzToEurPerGram(2500, null)).toBeNull();
  });

  it("es idempotente (misma entrada → misma salida)", () => {
    expect(goldUsdPerOzToEurPerGram(3000, 1.08)).toBe(goldUsdPerOzToEurPerGram(3000, 1.08));
  });
});

// ---------- W29: inversión de tasas Frankfurter a convención de la app ----------

import { frankfurterToFx } from "./useFX.js";
import { BASE_FX } from "./utils.js";

describe("frankfurterToFx (W29 — convención EUR por unidad)", () => {
  it("invierte rates de Frankfurter: MXN 21.7 → 0.0461 EUR por MXN", () => {
    const fx = frankfurterToFx({ MXN: 21.7, USD: 1.08, GBP: 0.85 });
    expect(fx.MXN).toBeCloseTo(1 / 21.7, 6);
    expect(fx.USD).toBeCloseTo(1 / 1.08, 6);
    expect(fx.GBP).toBeCloseTo(1 / 0.85, 6);
    expect(fx.EUR).toBe(1);
  });

  it("con la convención corregida, los assets EUR NO colapsan en base MXN", () => {
    // convert(127169, EUR→MXN) con fx correcto = 127169 / 0.0461 ≈ 2.76M (no 6.4K)
    const fx = frankfurterToFx({ MXN: 21.7 });
    const converted = (127169 * fx.EUR) / fx.MXN;
    expect(converted).toBeGreaterThan(2_000_000);
  });

  it("fallback a prev/BASE_FX cuando la API no trae una divisa", () => {
    const fx = frankfurterToFx({ MXN: 21.7 }, { USD: 0.9 });
    expect(fx.USD).toBe(0.9);
    expect(fx.GBP).toBe(BASE_FX.GBP);
  });

  it("rates inválidos (0/negativo/ausente) → fallback, nunca 0 ni Infinity", () => {
    const fx = frankfurterToFx({ MXN: 0, USD: -5 });
    expect(fx.MXN).toBe(BASE_FX.MXN);
    expect(fx.USD).toBe(BASE_FX.USD);
    expect(Number.isFinite(fx.MXN)).toBe(true);
  });
});
