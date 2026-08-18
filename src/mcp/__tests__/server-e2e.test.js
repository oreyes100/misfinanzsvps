// server-e2e.test.js — Flujo completo MCP en memoria: negotiate → listTools → callTool.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server";
import { negotiateWithClient } from "../client";

const token = (role, sub = "user_1") =>
  Buffer.from(JSON.stringify({ sub, role })).toString("base64");

async function spawnServer(options) {
  const { server } = createMcpServer(options);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "e2e-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client };
}

describe("MCP-01 E2E — descubrimiento por rol", () => {
  it("operador no descubre transfer_funds ni delete de admin", async () => {
    const { client } = await spawnServer();
    const n = await negotiateWithClient(client, {
      requestedScopes: ["read", "write", "ocr", "drive", "finance", "admin"],
      authToken: token("operator"),
      clientName: "e2e-operator",
    });

    expect(n.grantedScopes).not.toContain("finance");
    expect(n.grantedScopes).not.toContain("admin");
    expect(n.visibleTools).toContain("scan_receipt");
    expect(n.visibleTools).toContain("drive_status");
    expect(n.visibleTools).not.toContain("transfer_funds");
    await client.close();
  });

  it("admin descubre las 9 herramientas y get_balance responde de verdad", async () => {
    const { client } = await spawnServer();
    const n = await negotiateWithClient(client, {
      requestedScopes: ["read", "write", "finance", "admin", "drive", "ocr"],
      authToken: token("admin"),
      clientName: "e2e-admin",
    });

    expect(n.visibleTools).toHaveLength(9);
    expect(n.visibleTools).toContain("transfer_funds");
    expect(n.visibleTools).toContain("resilience_health");

    const res = await client.callTool({
      name: "get_balance",
      arguments: { syncCode: "corto" }, // inválido → sin red, ok:false
    });
    const text = res.content[0].text;
    expect(JSON.parse(text).data.ok).toBe(false);
    await client.close();
  });

  it("sin token: negociación denegada, 0 herramientas", async () => {
    const { client } = await spawnServer();
    const n = await negotiateWithClient(client, {
      requestedScopes: ["read", "finance"],
      clientName: "e2e-anon",
    });
    expect(n.grantedScopes).toHaveLength(0);
    expect(n.visibleTools).toHaveLength(0);
    await client.close();
  });

  it("transfer_funds: exige Idempotency-Key y devuelve PENDING_APPROVAL", async () => {
    const { client } = await spawnServer();
    await negotiateWithClient(client, {
      requestedScopes: ["read", "write", "finance"],
      authToken: token("finance"),
      clientName: "e2e-finance",
    });

    const args = { syncCode: "corto", fromAccountId: "a", toAccountId: "b", amount: 100 };

    const r1 = await client.callTool({ name: "transfer_funds", arguments: args });
    expect(r1.content[0].text).toContain("Idempotency-Key");

    const r2 = await client.callTool({
      name: "transfer_funds",
      arguments: { ...args, idempotencyKey: "k1" },
    });
    expect(r2.content[0].text).toContain("PENDING_APPROVAL");

    await client.close();
  });

  it("tools/list en producción llega con _meta de filtrado", async () => {
    const { client } = await spawnServer({ environment: "production" });
    await negotiateWithClient(client, {
      requestedScopes: ["read", "write", "ocr", "drive", "finance", "admin"],
      authToken: token("operator"),
      clientName: "e2e-meta",
    });

    const result = await client.listTools();
    expect(result._meta.filterReason).toBe("capability_negotiation");
    expect(result._meta.filteredOut).toBeGreaterThan(0);
    await client.close();
  });

  it("MCP-02: rate limit devuelve RATE_LIMITED al superar el límite", async () => {
    const { client } = await spawnServer({
      disableHealthCheck: true,
      resilienceOverrides: { get_balance: { rateLimitPerMinute: 2 } },
    });
    await negotiateWithClient(client, {
      requestedScopes: ["read", "write", "finance", "admin"],
      authToken: token("admin"),
      clientName: "e2e-rl",
    });

    const call = () => client.callTool({ name: "get_balance", arguments: { syncCode: "corto" } });

    const r1 = await call();
    const r2 = await call();
    const r3 = await call();

    expect(JSON.parse(r1.content[0].text).data.ok).toBe(false); // pasó
    expect(JSON.parse(r2.content[0].text).data.ok).toBe(false); // pasó
    expect(JSON.parse(r3.content[0].text).error.code).toBe("RATE_LIMITED");
    expect(r3._meta.retryable).toBe(true);
    await client.close();
  });

  it("MCP-02: resilience_health reporta el estado del sistema", async () => {
    const { client } = await spawnServer({ disableHealthCheck: true });
    await negotiateWithClient(client, {
      requestedScopes: ["read", "write", "finance", "admin"],
      authToken: token("admin"),
      clientName: "e2e-health",
    });

    const res = await client.callTool({ name: "resilience_health", arguments: {} });
    const report = JSON.parse(res.content[0].text).data;
    expect(report.overall.totalTools).toBe(9);
    expect(report.tools.every((t) => typeof t.isHealthy === "boolean")).toBe(true);
    await client.close();
  });
});