import { useEffect, useRef } from "react";
import { BASE_FX } from "./utils.js";

const REFRESH_MS = 30 * 60 * 1000;
export const TROY_OZ_GRAMS = 31.1034768;

/**
 * Convierte el precio del oro de USD/onza troy → EUR/gramo.
 * @param {number|null|undefined} usdPerOz
 * @param {number} usdPerEur — tasa EUR→USD del fx
 * @returns {number|null} EUR/gramo o null si no hay dato/tasa
 */
export function goldUsdPerOzToEurPerGram(usdPerOz, usdPerEur) {
  if (!usdPerOz || !usdPerEur) return null;
  return Math.round((usdPerOz / TROY_OZ_GRAMS / usdPerEur) * 100) / 100;
}

/**
 * W29: convierte rates de Frankfurter ("unidades por EUR", p. ej. MXN: 21.7)
 * a la convención interna de la app ("EUR por unidad", p. ej. MXN: 0.0461).
 * Sin esta inversión, los assets en EUR colapsan y las cuentas se distorsionan
 * cuando la divisa base no es EUR. Crypto (BTC/ETH ya en EUR) va aparte.
 */
export function frankfurterToFx(rates, prev = {}, base = BASE_FX) {
  const r = rates || {};
  const inv = (v, fallback) => (v > 0 ? 1 / v : fallback);
  return {
    EUR: 1,
    USD: inv(r.USD, prev.USD ?? base.USD),
    GBP: inv(r.GBP, prev.GBP ?? base.GBP),
    MXN: inv(r.MXN, prev.MXN ?? base.MXN),
  };
}

export default function useFX(dispatch, fxRef) {
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function fetchRates() {
      try {
        // W29: Frankfurter migró de api.frankfurter.app (301 sin CORS, rompía el
        // navegador) a api.frankfurter.dev/v1. Fallback al dominio viejo por si acaso.
        const fiatRes = await fetch("https://api.frankfurter.dev/v1/latest?base=EUR").catch(() =>
          fetch("https://api.frankfurter.app/latest?base=EUR")
        );
        const [cryptoRes, goldRes] = await Promise.all([
          fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=eur"),
          fetch("https://api.gold-api.com/price/XAU").catch(() => null),
        ]);
        if (!mountedRef.current) return;

        const fiatData = fiatRes.ok ? await fiatRes.json() : {};
        const cryptoData = cryptoRes.ok ? await cryptoRes.json() : {};
        const goldData = goldRes?.ok ? await goldRes.json() : {};

        // W29 FIX CRÍTICO: invertir las tasas a la convención de la app
        // ("EUR por unidad"). Ver frankfurterToFx.
        const fx = {
          ...frankfurterToFx(fiatData.rates, fxRef.current),
          BTC: cryptoData?.bitcoin?.eur ?? fxRef.current?.BTC ?? BASE_FX.BTC,
          ETH: cryptoData?.ethereum?.eur ?? fxRef.current?.ETH ?? BASE_FX.ETH,
        };
        fxRef.current = fx;

        // Oro: gold-api devuelve USD/onza troy → EUR/gramo.
        const goldPriceEUR = goldUsdPerOzToEurPerGram(goldData?.price, fx.USD);
        dispatch({
          type: "update_fx",
          fx,
          goldPriceEUR,
          priceHistory: { BTC: fx.BTC, ETH: fx.ETH, GOLD: goldPriceEUR },
        });
      } catch {
        // API unavailable — keep current rates, no updates
      }
    }

    fetchRates();
    const id = setInterval(fetchRates, REFRESH_MS);
    return () => { mountedRef.current = false; clearInterval(id); };
  }, [dispatch, fxRef]);
}
