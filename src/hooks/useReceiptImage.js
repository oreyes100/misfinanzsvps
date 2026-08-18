import { useEffect, useState } from "react";
import { loadReceipt } from "../services/receiptStorage.js";

/**
 * Hook para cargar la imagen de un recibo desde IndexedDB como blob URL.
 * Genera y libera la URL al desmontar.
 */
export function useReceiptImage(receiptId) {
  const [imageUrl, setImageUrl] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!receiptId) {
      setImageUrl(null);
      setLoading(false);
      return;
    }
    let url = null;
    let cancelled = false;
    setLoading(true);
    loadReceipt(receiptId)
      .then((blob) => {
        if (cancelled) return;
        if (blob) {
          url = URL.createObjectURL(blob);
          setImageUrl(url);
        } else {
          setImageUrl(null);
        }
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [receiptId]);

  return { imageUrl, loading };
}