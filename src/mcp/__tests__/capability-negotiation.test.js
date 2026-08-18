// capability-negotiation.test.js — Tests unitarios del "Escudo de Descubrimiento".
import { describe, it, expect, beforeEach } from "vitest";
import { DynamicToolRegistry } from "../tool-registry";
import { McpAuthMiddleware } from "../auth-middleware";
import { registerRealTools } from "../real-tools";

const token = (role, sub = "user_1") =>
  Buffer.from(JSON.stringify({ sub, role })).toString("base64");

function buildHarness() {
  const registry = new DynamicToolRegistry();
  const auth = new McpAuthMiddleware(registry);

  registry.register({
    name: "read_tool",
    description: "Herramienta de lectura",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ ok: true }),
    requiredScopes: ["read"],
    sensitivity: "low",
    requiresIdempotency: false,
    requiresHumanApproval: false,
    rateLimitPerMinute: 60,
  });

  registry.register({
    name: "finance_tool",
    description: "Herramienta financiera",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ ok: true }),
    requiredScopes: ["read", "finance"],
    sensitivity: "critical",
    requiresIdempotency: true,
    requiresHumanApproval: true,
    rateLimitPerMinute: 10,
  });

  registry.register({
    name: "admin_tool",
    description: "Herramienta de administración",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ ok: true }),
    requiredScopes: ["admin"],
    sensitivity: "critical",
    requiresIdempotency: true,
    requiresHumanApproval: true,
    rateLimitPerMinute: 5,
  });

  return { registry, auth };
}

describe("DynamicToolRegistry — filtrado por scopes", () => {
  let registry;
  beforeEach(() => {
    registry = buildHarness().registry;
  });

  it("muestra todas las herramientas con scopes completos", () => {
    const { tools, filteredOut } = registry.getFilteredTools(["read", "finance", "admin"]);
    expect(tools).toHaveLength(3);
    expect(filteredOut).toBe(0);
  });

  it("oculta herramientas financieras sin scope finance", () => {
    const { tools, filteredOut } = registry.getFilteredTools(["read"]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read_tool");
    expect(filteredOut).toBe(2);
  });

  it("oculta herramientas admin sin scope admin", () => {
    const names = registry.namesFor(["read", "finance"]);
    expect(names).toContain("read_tool");
    expect(names).toContain("finance_tool");
    expect(names).not.toContain("admin_tool");
  });

  it("puede desregistrar una herramienta dinámicamente", () => {
    registry.unregister("admin_tool");
    expect(registry.getTool("admin_tool")).toBeUndefined();
    expect(registry.listAll()).toHaveLength(2);
  });
});

describe("McpAuthMiddleware — autorización de tool calls", () => {
  let auth;
  beforeEach(() => {
    auth = buildHarness().auth;
  });

  it("autoriza con scopes suficientes", () => {
    const r = auth.authorizeToolCall("read_tool", ["read"]);
    expect(r.authorized).toBe(true);
    expect(r.requiresApproval).toBe(false);
  });

  it("deniega sin scopes suficientes", () => {
    const r = auth.authorizeToolCall("finance_tool", ["read"]);
    expect(r.authorized).toBe(false);
    expect(r.reason).toContain("Scopes insuficientes");
  });

  it("deniega herramientas inexistentes", () => {
    const r = auth.authorizeToolCall("hack_tool", ["read", "write", "admin"]);
    expect(r.authorized).toBe(false);
    expect(r.reason).toContain("no existe");
  });

  it("exige Idempotency-Key si la herramienta lo requiere", () => {
    const r = auth.authorizeToolCall("finance_tool", ["read", "finance"]);
    expect(r.authorized).toBe(false);
    expect(r.reason).toContain("Idempotency-Key");
  });

  it("autoriza con Idempotency-Key y marca aprobación humana (critical)", () => {
    const r = auth.authorizeToolCall("finance_tool", ["read", "finance"], "idem_123");
    expect(r.authorized).toBe(true);
    expect(r.requiresApproval).toBe(true);
  });
});

describe("McpAuthMiddleware — negociación de scopes", () => {
  let auth;
  beforeEach(() => {
    auth = buildHarness().auth;
  });

  const negotiate = (role, requestedScopes) =>
    auth.handleNegotiate({
      method: "capability/negotiate",
      params: {
        requestedScopes,
        clientCapabilities: {},
        authToken: token(role),
      },
    });

  it("otorga solo la intersección de scopes del rol operator", async () => {
    const res = await negotiate("operator", ["read", "write", "finance", "admin"]);
    expect(res.grantedScopes).toContain("read");
    expect(res.grantedScopes).toContain("write");
    expect(res.grantedScopes).not.toContain("finance");
    expect(res.grantedScopes).not.toContain("admin");
    expect(res.deniedScopes.map((d) => d.scope)).toContain("finance");
  });

  it("negación sin token: ningún scope otorgado", async () => {
    const res = await auth.handleNegotiate({
      method: "capability/negotiate",
      params: { requestedScopes: ["read", "finance"] },
    });
    expect(res.grantedScopes).toHaveLength(0);
    expect(res.visibleToolCount).toBe(0);
  });

  it("admin ve todas las herramientas", async () => {
    const res = await negotiate("admin", ["read", "write", "finance", "admin"]);
    expect(res.grantedScopes).toHaveLength(4);
    expect(res.visibleToolCount).toBe(3);
  });
});

describe("Obfuscación de schemas", () => {
  it("en producción obfusca schemas de herramientas con scopes parciales", () => {
    const { registry } = buildHarness();
    const tool = registry.register({
      name: "secret_tool",
      description: "con schema sensible",
      inputSchema: {
        type: "object",
        properties: {
          token: { type: "string", description: "secreto", sensitivity: "critical" },
          normal: { type: "string", description: "normal" },
        },
        required: ["token"],
      },
      handler: async () => ({ ok: true }),
      requiredScopes: ["read"],
      sensitivity: "critical",
      requiresIdempotency: true,
      requiresHumanApproval: true,
      rateLimitPerMinute: 5,
    });

    const { tools } = registry.getFilteredTools(["read"], { obfuscateSchemas: true });
    const secret = tools.find((t) => t.name === "secret_tool");
    expect(secret).toBeDefined();
    expect(secret._capability.schemaObfuscated).toBe(true);
    expect(secret.inputSchema.properties.token.description).toContain("REDACTED");
    expect(secret.inputSchema.properties.normal.description).toBe("normal");

    const { tools: adminTools } = registry.getFilteredTools(["read", "admin"], { obfuscateSchemas: true });
    const adminSecret = adminTools.find((t) => t.name === "secret_tool");
    expect(adminSecret._capability.schemaObfuscated).toBe(false);
    expect(adminSecret.inputSchema.properties.token.description).toBe("secreto");
  });
});

describe("registerRealTools — herramientas reales del proyecto", () => {
  let registry;
  let auth;
  beforeEach(() => {
    registry = registerRealTools(new DynamicToolRegistry());
    auth = new McpAuthMiddleware(registry);
  });

  it("registra 8 herramientas reales", () => {
    expect(registry.listAll()).toHaveLength(8);
  });

  it("rol operator ve lectura+OCR+drive pero NO finance ni admin", async () => {
    const res = await auth.handleNegotiate({
      method: "capability/negotiate",
      params: { requestedScopes: ["read", "write", "ocr", "drive", "finance", "admin"], authToken: token("operator") },
    });
    const names = registry.namesFor(res.grantedScopes);
    expect(names).toContain("scan_receipt");
    expect(names).toContain("drive_status");
    expect(names).toContain("get_balance");
    expect(names).not.toContain("transfer_funds");
  });

  it("rol finance ve transfer_funds y requiere aprobación + idempotencia", async () => {
    const res = await auth.handleNegotiate({
      method: "capability/negotiate",
      params: { requestedScopes: ["read", "write", "finance"], authToken: token("finance") },
    });
    const names = registry.namesFor(res.grantedScopes);
    expect(names).toContain("transfer_funds");
    expect(names).toContain("add_transaction");

    const call = auth.authorizeToolCall("transfer_funds", res.grantedScopes);
    expect(call.authorized).toBe(false); // falta Idempotency-Key
    const call2 = auth.authorizeToolCall("transfer_funds", res.grantedScopes, "idem_1");
    expect(call2.authorized).toBe(true);
    expect(call2.requiresApproval).toBe(true);
  });

  it("admin ve todas las herramientas reales", async () => {
    const res = await auth.handleNegotiate({
      method: "capability/negotiate",
      params: { requestedScopes: ["read", "write", "finance", "admin", "drive", "ocr"], authToken: token("admin") },
    });
    expect(registry.namesFor(res.grantedScopes)).toHaveLength(8);
  });
});
