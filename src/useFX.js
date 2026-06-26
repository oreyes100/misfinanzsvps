import { useEffect, useRef } from "react";
import { BASE_FX } from "./utils.js";

const REFRESH_MS = 30 * 60 * 1000;

function push(arr, v, max = 60) {
  return [...arr.slice(-(max - 1)), v];
}

export default function useFX(dispatch, fxRef) {
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function fetchRates() {
      try {
        const [fiatRes, cryptoRes] = await Promise.all([
          fetch("https://api.frankfurter.app/latest?base=EUR"),
          fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=eur"),
        ]);
        if (!mountedRef.current) return;

        const fiatData = fiatRes.ok ? await fiatRes.json() : {};
        const cryptoData = cryptoRes.ok ? await cryptoRes.json() : {};

        const fx = {
          EUR: 1,
          USD: fiatData.rates?.USD ?? fxRef.current?.USD ?? BASE_FX.USD,
          GBP: fiatData.rates?.GBP ?? fxRef.current?.GBP ?? BASE_FX.GBP,
          MXN: fiatData.rates?.MXN ?? fxRef.current?.MXN ?? BASE_FX.MXN,
          BTC: cryptoData?.bitcoin?.eur ?? fxRef.current?.BTC ?? BASE_FX.BTC,
          ETH: cryptoData?.ethereum?.eur ?? fxRef.current?.ETH ?? BASE_FX.ETH,
        };
        fxRef.current = fx;
        dispatch({ type: "update_fx", fx, priceHistory: { BTC: fx.BTC, ETH: fx.ETH } });
      } catch {
        // API unavailable — keep current rates, no updates
      }
    }

    fetchRates();
    const id = setInterval(fetchRates, REFRESH_MS);
    return () => { mountedRef.current = false; clearInterval(id); };
  }, [dispatch, fxRef]);
}
