// health-dashboard.ts — Reportes de salud del sistema de resiliencia en texto y JSON.

import { CircuitState, type ResilienceEvent, type ToolHealthReport, type ToolHealthStatus } from "./types.ts";

type EventWithTimestamp = ResilienceEvent & { timestamp: number };

export class HealthDashboard {
  private eventLog: EventWithTimestamp[] = [];
  private maxLogSize = 1000;

  logEvent(event: ResilienceEvent): void {
    this.eventLog.push({ ...event, timestamp: Date.now() });
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize);
    }
  }

  generateTextReport(statuses: ToolHealthStatus[]): string {
    const lines: string[] = [
      "╔══════════════════════════════════════════════════════════════╗",
      "║           MCP RESILIENCE DASHBOARD - HEALTH REPORT           ║",
      "╠══════════════════════════════════════════════════════════════╣",
      `║  Timestamp: ${new Date().toISOString().padEnd(49)}║`,
      "╠══════════════════════════════════════════════════════════════╣",
    ];

    for (const status of statuses) {
      const icon =
        status.circuitState === CircuitState.CLOSED ? "🟢" : status.circuitState === CircuitState.HALF_OPEN ? "🟡" : "🔴";
      lines.push(
        `║ ${icon} ${status.tool.padEnd(20)} ` +
        `Err: ${(status.errorRate * 100).toFixed(1).padStart(5)}% ` +
        `Reqs: ${String(status.requestsInWindow).padStart(4)} ` +
        `Queue: ${String(status.queueDepth).padStart(3)} ` +
        `${status.isHealthy ? "✅" : "❌"}  ║`
      );
    }

    lines.push("╠══════════════════════════════════════════════════════════════╣");
    for (const event of this.eventLog.slice(-5)) {
      lines.push(`║ 📋 ${this.formatEvent(event).padEnd(57)}║`);
    }
    lines.push("╚══════════════════════════════════════════════════════════════╝");

    return lines.join("\n");
  }

  generateJsonReport(statuses: ToolHealthStatus[]): ToolHealthReport {
    const healthy = statuses.filter((s) => s.isHealthy).length;
    return {
      timestamp: new Date().toISOString(),
      overall: {
        healthyTools: healthy,
        totalTools: statuses.length,
        healthPercentage: statuses.length > 0 ? (healthy / statuses.length) * 100 : 0,
        openCircuits: statuses.filter((s) => s.circuitState === CircuitState.OPEN).length,
      },
      tools: statuses,
      recentEvents: this.eventLog.slice(-20).map((e) => ({ ...e, formatted: this.formatEvent(e) })),
    };
  }

  private formatEvent(event: ResilienceEvent): string {
    switch (event.type) {
      case "circuit_opened":
        return `Circuit OPEN: ${event.tool} (${event.failureCount} fallos)`;
      case "circuit_half_open":
        return `Circuit HALF_OPEN: ${event.tool}`;
      case "circuit_closed":
        return `Circuit CLOSED: ${event.tool} ✅`;
      case "rate_limit_exceeded":
        return `Rate limit: ${event.tool} → ${event.clientId} (retry ${event.retryAfterMs}ms)`;
      case "queue_full":
        return `Queue FULL: ${event.tool} (${event.queueSize} items)`;
      case "backpressure_applied":
        return `Backpressure: ${event.tool} (${event.rejectedCount} rechazados)`;
      case "fallback_activated":
        return `Fallback: ${event.tool} → ${event.fallbackType}`;
      case "timeout":
        return `Timeout: ${event.tool} (${event.timeoutMs}ms)`;
      default:
        return JSON.stringify(event);
    }
  }
}