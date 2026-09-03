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

        const fx = {
          EUR: 1,
          USD: fiatData.rates?.USD ?? fxRef.current?.USD ?? BASE_FX.USD,
          GBP: fiatData.rates?.GBP ?? fxRef.current?.GBP ?? BASE_FX.GBP,
          MXN: fiatData.rates?.MXN ?? fxRef.current?.MXN ?? BASE_FX.MXN,
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
