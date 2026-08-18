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
