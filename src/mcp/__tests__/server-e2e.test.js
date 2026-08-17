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

  it("admin descubre las 8 herramientas y get_balance responde de verdad", async () => {
    const { client } = await spawnServer();
    const n = await negotiateWithClient(client, {
      requestedScopes: ["read", "write", "finance", "admin", "drive", "ocr"],
      authToken: token("admin"),
      clientName: "e2e-admin",
    });

    expect(n.visibleTools).toHaveLength(8);
    expect(n.visibleTools).toContain("transfer_funds");

    const res = await client.callTool({
      name: "get_balance",
      arguments: { syncCode: "corto" }, // inválido → sin red, ok:false
    });
    const text = res.content[0].text;
    expect(JSON.parse(text).ok).toBe(false);
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
});