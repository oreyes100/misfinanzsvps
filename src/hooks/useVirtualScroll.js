// useVirtualScroll.js — Virtual scrolling (FASE 3: rendimiento con miles de items).
//
// Solo renderiza los items visibles en el viewport (con overscan) dentro de un
// contenedor con scroll nativo. El resto del espacio se simula con un spacer
// de `totalHeight`. DOM: ~(viewport/height + 2*overscan) nodos en vez de N.

import { useCallback, useMemo, useRef, useState } from "react";

export function useVirtualScroll({
  itemCount = 0,
  itemHeight = 88,
  overscan = 6,
  containerHeight = 640,
  scrollRef,
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const internalRef = useRef(null);
  const containerRef = scrollRef ?? internalRef;

  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(
    Math.max(itemCount - 1, 0),
    Math.floor((scrollTop + containerHeight) / itemHeight) + overscan
  );

  const onScroll = useCallback((e) => {
    setScrollTop(e.target.scrollTop);
  }, []);

  return useMemo(
    () => ({
      containerRef,
      onScroll,
      totalHeight: itemCount * itemHeight,
      offsetY: startIndex * itemHeight,
      startIndex,
      endIndex,
      visibleCount: Math.max(0, endIndex - startIndex + 1),
    }),
    [containerRef, onScroll, itemCount, itemHeight, startIndex, endIndex]
  );
}