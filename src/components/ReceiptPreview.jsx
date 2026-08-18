import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useReceiptImage } from "../hooks/useReceiptImage.js";
import { Glass, Btn } from "./UI.jsx";

/**
 * ═══ ReceiptPreview (RECEIPT VISION) ═══
 * Thumbnail del recibo con click para ampliar, y viewer full-screen con
 * zoom (0.5–3x) y rotación (90°). Fuentes de imagen:
 *  - receiptUrl: URL remota (Google Photos thumbnail)
 *  - receiptBlob: blob ya en memoria (OCR reciente)
 *  - receiptId: referencia a IndexedDB (persistente)
 */

function resolveImageUrl({ receiptUrl, receiptBlob, receiptId, imageFromHook }) {
  if (receiptUrl) return receiptUrl;
  if (receiptBlob) return URL.createObjectURL(receiptBlob);
  if (receiptId && imageFromHook) return imageFromHook;
  return null;
}

export function ReceiptThumbnail({ receiptUrl, receiptBlob, receiptId, alt, onClick, size = "w-16 h-16" }) {
  const { imageUrl, loading } = useReceiptImage(receiptId);
  const [localUrl, setLocalUrl] = useState(null);

  useEffect(() => {
    if (receiptBlob) {
      const url = URL.createObjectURL(receiptBlob);
      setLocalUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setLocalUrl(null);
  }, [receiptBlob]);

  const src = resolveImageUrl({ receiptUrl, receiptBlob: localUrl, receiptId, imageFromHook: imageUrl });

  if (!src) {
    return (
      <div className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-white/6 text-2xl`} aria-hidden="true">
        🧾
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={loading ? `Cargando recibo: ${alt}` : `Ver recibo: ${alt}`}
      className={`${size} group relative shrink-0 overflow-hidden rounded-lg border-2 border-white/10 transition-colors hover:border-accent/60`}
    >
      <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover" />
      <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-lg text-white opacity-0 transition-opacity group-hover:bg-black/40 group-hover:opacity-100" aria-hidden="true">
        🔍
      </span>
    </button>
  );
}

export function ReceiptViewer({ receiptUrl, receiptBlob, receiptId, onClose, ocrData }) {
  const reduceMotion = useReducedMotion();
  const { imageUrl } = useReceiptImage(receiptId);
  const [localUrl, setLocalUrl] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    if (receiptBlob) {
      const url = URL.createObjectURL(receiptBlob);
      setLocalUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setLocalUrl(null);
  }, [receiptBlob]);

  const src = useMemo(
    () => resolveImageUrl({ receiptUrl, receiptBlob: localUrl, receiptId, imageFromHook: imageUrl }),
    [receiptUrl, localUrl, receiptId, imageUrl]
  );

  if (!src) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.15 }}
      className="fixed inset-0 z-[70] flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label="Vista de recibo"
    >
      <div className="flex items-center justify-between p-4">
        <h3 className="text-base font-medium text-white">📷 Recibo original</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="flex size-10 items-center justify-center rounded-full text-2xl text-white hover:bg-white/15"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={src}
          alt="Recibo"
          className="max-h-full max-w-full select-none"
          style={{ transform: `scale(${zoom}) rotate(${rotation}deg)`, transition: "transform 0.2s" }}
        />
      </div>

      <div className="flex items-center justify-center gap-2 p-4">
        <Btn size="sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Alejar">🔍−</Btn>
        <span className="px-2 text-sm text-white">{Math.round(zoom * 100)}%</span>
        <Btn size="sm" variant="ghost" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Acercar">🔍+</Btn>
        <Btn size="sm" variant="ghost" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Rotar">↻ Rotar</Btn>
      </div>

      {ocrData && (
        <div className="border-t border-white/15 bg-black/60 p-4 text-sm text-white">
          <p className="mb-1"><strong>OCR extrajo:</strong> {ocrData.merchant}, {ocrData.amount}€, {ocrData.date}</p>
          <p className="text-xs text-white/60">Confianza: {Math.round(ocrData.confidence * 100)}%</p>
        </div>
      )}
    </motion.div>
  );
}