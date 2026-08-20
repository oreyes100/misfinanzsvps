import { describe, expect, it } from "vitest";
import {
  DAY_KEY,
  COUNT_KEY,
  MAX_NOTIFS_PER_DAY,
  MIN_TIME_BETWEEN_NOTIFS_MS,
  todayKey,
  shouldShowNotification,
} from "./notificationPolicy.js";

describe("notificationPolicy · todayKey", () => {
  it("formatea la clave de día como YYYY-M-D", () => {
    const d = new Date(2026, 7, 20); // 20 ago 2026
    expect(todayKey(d)).toBe("2026-7-20");
  });

  it("distingue días distintos", () => {
    const a = todayKey(new Date(2026, 7, 20));
    const b = todayKey(new Date(2026, 7, 21));
    expect(a).not.toBe(b);
  });

  it("DAY_KEY y COUNT_KEY son constantes estables", () => {
    expect(DAY_KEY).toBe("mis-finazas-mcp-notif-day");
    expect(COUNT_KEY).toBe("mis-finazas-mcp-notif-count");
  });
});

describe("notificationPolicy · shouldShowNotification", () => {
  const now = 1_000_000_000_000;
  const base = { pendingCount: 3, inMcp: false, visible: false, usedToday: 0, lastShownAt: 0, now };

  it("no muestra si el usuario está en el menú MCP", () => {
    expect(shouldShowNotification({ ...base, inMcp: true })).toBe(false);
  });

  it("no muestra si no hay pendientes", () => {
    expect(shouldShowNotification({ ...base, pendingCount: 0 })).toBe(false);
  });

  it("no muestra si se alcanzó el límite diario", () => {
    expect(shouldShowNotification({ ...base, usedToday: MAX_NOTIFS_PER_DAY })).toBe(false);
    expect(shouldShowNotification({ ...base, usedToday: MAX_NOTIFS_PER_DAY + 2 })).toBe(false);
  });

  it("coalescencia: si ya está visible, muestra (solo actualiza contador)", () => {
    expect(shouldShowNotification({ ...base, visible: true })).toBe(true);
  });

  it("no muestra si la última fue hace menos de 30s", () => {
    expect(
      shouldShowNotification({ ...base, lastShownAt: now - (MIN_TIME_BETWEEN_NOTIFS_MS - 1) })
    ).toBe(false);
  });

  it("muestra si pasaron al menos 30s desde la última", () => {
    expect(
      shouldShowNotification({ ...base, lastShownAt: now - MIN_TIME_BETWEEN_NOTIFS_MS })
    ).toBe(true);
  });

  it("primera vez sin historial → muestra", () => {
    expect(shouldShowNotification(base)).toBe(true);
  });

  it("el límite diario también aplica en modo coalescencia", () => {
    expect(shouldShowNotification({ ...base, visible: true, usedToday: MAX_NOTIFS_PER_DAY })).toBe(false);
  });
});