// schema-validator.ts — Validación de schemas de tool calls (MCP-04).
//
// Valida parámetros contra JSON Schema (draft-2020-12) con reglas de seguridad:
//   - Tipos estrictos, required, enum/const/pattern
//   - Rechazo de additionalProperties no declaradas
//   - Límites de tamaño (string/array) y números finitos
//   - Detección de SQL / command / prompt / path / XSS / LDAP / template injection
//
// Nota: `valid` es true solo si NO hay errores (ninguna severidad). A diferencia
// de la propuesta (que solo contaba "fatal"), un TYPE_MISMATCH debe bloquear.
//
// Sanitización: filtra a propiedades declaradas SIN escapar strings. Como la
// validación ya RECHAZA los patrones de inyección (fatal), escapar solo
// corrompería datos reales (p.ej. una descripción "Dominos > Pizza").

import { createHash } from "node:crypto";
import type { SchemaValidationResult, SchemaValidationError, SchemaValidationWarning } from "./security-types.ts";

export interface SchemaValidationConfig {
  strictMode: boolean;
  rejectAdditionalProperties: boolean;
  maxParamStringLength: number;
  maxArrayLength: number;
  detectInjectionPatterns: boolean;
}

export class SchemaValidator {
  private readonly config: SchemaValidationConfig;
  private injectionPatterns: RegExp[] = [];

  constructor(config: SchemaValidationConfig) {
    this.config = config;
    this.initInjectionPatterns();
  }

  private initInjectionPatterns(): void {
    this.injectionPatterns = [
      // SQL Injection
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER)\b.*\b(FROM|INTO|TABLE|WHERE)\b)/i,
      /(--|#|\/\*|\*\/|;)/,
      /(\bOR\b\s+\d+\s*=\s*\d+)/i,
      /(\bAND\b\s+\d+\s*=\s*\d+)/i,

      // Command Injection
      /(\||;|&|\$\(|`|>\s|<\s)/,
      /(\brm\b\s+-rf|\bcat\b\s+\/etc|\bchmod\b|\bchown\b)/i,
      /(\bcurl\b|\bwget\b|\bnc\b|\bncat\b)/i,

      // Prompt Injection
      /(ignore\s+(all\s+)?previous\s+instructions)/i,
      /(disregard\s+(all\s+)?prior)/i,
      /(you\s+are\s+now\s+in\s+developer\s+mode)/i,
      /(system\s*:\s*you\s+must)/i,
      /(\[INST\]|\[\/INST\]|<<SYS>>|<\|im_start\|>)/i,
      /(jailbreak|DAN\s+mode|bypass\s+filter)/i,

      // Path Traversal
      /(\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e\/)/i,
      /(\/etc\/passwd|\/etc\/shadow|\/root\/\.ssh)/i,
      /(C:\\Windows\\System32|C:\\Users\\Administrator)/i,

      // XSS
      /(<script|javascript:|on\w+\s*=)/i,
      /(eval\s*\(|document\.cookie|window\.location)/i,

      // LDAP Injection
      /(\*\)\(\||\)\(\&|\)\(\!)/,

      // Template Injection
      /(\{\{.*\}\}|\{%.*%\}|\$\{.*\})/,
    ];
  }

  /** ═══ CORE: Validar parámetros contra un schema ═══ */
  validate(
    toolName: string,
    params: Record<string, unknown>,
    schema: Record<string, unknown>
  ): SchemaValidationResult {
    const startTime = Date.now();
    const errors: SchemaValidationError[] = [];
    const warnings: SchemaValidationWarning[] = [];
    let rulesApplied = 0;

    const properties = (schema.properties || {}) as Record<string, any>;
    const required = (schema.required || []) as string[];

    for (const reqField of required) {
      rulesApplied++;
      if (!(reqField in params) || params[reqField] === undefined || params[reqField] === null) {
        errors.push({
          path: reqField,
          code: "REQUIRED_MISSING",
          message: `Campo requerido '${reqField}' no está presente`,
          severity: "fatal",
        });
      }
    }

    for (const [key, value] of Object.entries(params)) {
      rulesApplied++;

      if (this.config.rejectAdditionalProperties && !(key in properties)) {
        errors.push({
          path: key,
          code: "ADDITIONAL_PROPERTY",
          message: `Propiedad '${key}' no está declarada en el schema`,
          severity: this.config.strictMode ? "fatal" : "error",
        });
        continue;
      }

      const propSchema = properties[key];
      if (!propSchema) continue;

      const typeErrors = this.validateType(key, value, propSchema);
      errors.push(...typeErrors);
      rulesApplied++;

      if (typeof value === "string") {
        const stringErrors = this.validateStringConstraints(key, value, propSchema);
        errors.push(...stringErrors);
        rulesApplied++;

        if (this.config.detectInjectionPatterns) {
          const injectionResult = this.detectInjection(key, value);
          if (injectionResult.detected) {
            errors.push({
              path: key,
              code: "INJECTION_DETECTED",
              message: `Posible inyección detectada en '${key}': ${injectionResult.pattern}`,
              severity: "fatal",
            });
            rulesApplied++;
          }
        }
      }

      if (Array.isArray(value)) {
        const arrayErrors = this.validateArrayConstraints(key, value, propSchema);
        errors.push(...arrayErrors);
        rulesApplied++;
      }

      if (typeof value === "number") {
        const numberErrors = this.validateNumberConstraints(key, value, propSchema);
        errors.push(...numberErrors);
        rulesApplied++;
      }

      if (propSchema.enum && !propSchema.enum.includes(value)) {
        errors.push({
          path: key,
          code: "ENUM_VIOLATION",
          message: `Valor '${String(value)}' no está en el enum permitido: [${propSchema.enum.join(", ")}]`,
          severity: "error",
        });
        rulesApplied++;
      }

      if (propSchema.const !== undefined && value !== propSchema.const) {
        errors.push({
          path: key,
          code: "CONST_VIOLATION",
          message: `Valor debe ser exactamente '${String(propSchema.const)}'`,
          severity: "error",
        });
        rulesApplied++;
      }

      if (propSchema.pattern && typeof value === "string") {
        const regex = new RegExp(propSchema.pattern);
        if (!regex.test(value)) {
          errors.push({
            path: key,
            code: "PATTERN_MISMATCH",
            message: `Valor no coincide con el patrón requerido: ${propSchema.pattern}`,
            severity: "error",
          });
          rulesApplied++;
        }
      }
    }

    const paramsSize = JSON.stringify(params).length;
    const maxSize = this.config.maxParamStringLength * Object.keys(params).length;
    if (paramsSize > maxSize) {
      warnings.push({
        path: "$",
        code: "PARAMS_SIZE_LARGE",
        message: `Tamaño total de parámetros (${paramsSize} bytes) es elevado`,
        suggestion: "Considera reducir el tamaño de los parámetros",
      });
    }

    const valid = errors.length === 0;

    return {
      valid,
      errors,
      warnings,
      sanitizedParams: valid ? this.sanitizeParams(params, properties) : undefined,
      metadata: {
        validationTimeMs: Date.now() - startTime,
        schemaVersion: (schema.$schema as string) || "draft-2020-12",
        schemaHash: this.computeHash(JSON.stringify(schema)),
        rulesApplied,
      },
    };
  }

  private validateType(path: string, value: unknown, propSchema: any): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];
    const expectedType = propSchema.type;
    if (!expectedType) return errors;

    const actualType = this.getJsonType(value);
    const typeMatches = Array.isArray(expectedType)
      ? expectedType.some((t) => this.typeEquals(t, actualType))
      : this.typeEquals(expectedType, actualType);

    if (!typeMatches) {
      errors.push({
        path,
        code: "TYPE_MISMATCH",
        message: `Tipo esperado '${expectedType}', recibido '${actualType}'`,
        severity: "error",
      });
    }
    return errors;
  }

  /** JSON Schema: "integer" es un subtipo de "number". */
  private typeEquals(expected: string, actual: string): boolean {
    if (expected === actual) return true;
    return expected === "number" && actual === "integer";
  }

  private getJsonType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
    return typeof value;
  }

  private validateStringConstraints(path: string, value: string, propSchema: any): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];

    if (propSchema.maxLength !== undefined && value.length > propSchema.maxLength) {
      errors.push({
        path,
        code: "STRING_TOO_LONG",
        message: `String excede maxLength (${value.length} > ${propSchema.maxLength})`,
        severity: "error",
      });
    }

    if (propSchema.minLength !== undefined && value.length < propSchema.minLength) {
      errors.push({
        path,
        code: "STRING_TOO_SHORT",
        message: `String no alcanza minLength (${value.length} < ${propSchema.minLength})`,
        severity: "error",
      });
    }

    if (value.length > this.config.maxParamStringLength) {
      errors.push({
        path,
        code: "STRING_EXCEEDS_SECURITY_LIMIT",
        message: `String excede el límite de seguridad (${this.config.maxParamStringLength})`,
        severity: "fatal",
      });
    }

    return errors;
  }

  private validateArrayConstraints(path: string, value: unknown[], propSchema: any): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];

    if (propSchema.maxItems !== undefined && value.length > propSchema.maxItems) {
      errors.push({
        path,
        code: "ARRAY_TOO_LONG",
        message: `Array excede maxItems (${value.length} > ${propSchema.maxItems})`,
        severity: "error",
      });
    }

    if (propSchema.minItems !== undefined && value.length < propSchema.minItems) {
      errors.push({
        path,
        code: "ARRAY_TOO_SHORT",
        message: `Array no alcanza minItems (${value.length} < ${propSchema.minItems})`,
        severity: "error",
      });
    }

    if (value.length > this.config.maxArrayLength) {
      errors.push({
        path,
        code: "ARRAY_EXCEEDS_SECURITY_LIMIT",
        message: `Array excede el límite de seguridad (${this.config.maxArrayLength})`,
        severity: "fatal",
      });
    }

    return errors;
  }

  private validateNumberConstraints(path: string, value: number, propSchema: any): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];

    if (propSchema.minimum !== undefined && value < propSchema.minimum) {
      errors.push({
        path,
        code: "NUMBER_BELOW_MINIMUM",
        message: `Valor ${value} es menor que minimum (${propSchema.minimum})`,
        severity: "error",
      });
    }

    if (propSchema.maximum !== undefined && value > propSchema.maximum) {
      errors.push({
        path,
        code: "NUMBER_ABOVE_MAXIMUM",
        message: `Valor ${value} es mayor que maximum (${propSchema.maximum})`,
        severity: "error",
      });
    }

    if (!Number.isFinite(value)) {
      errors.push({
        path,
        code: "NUMBER_NOT_FINITE",
        message: "Valor numérico no es finito (NaN o Infinity)",
        severity: "fatal",
      });
    }

    return errors;
  }

  /** ═══ CORE: Detectar patrones de inyección ═══ */
  detectInjection(path: string, value: string): { detected: boolean; pattern?: string } {
    for (const pattern of this.injectionPatterns) {
      if (pattern.test(value)) {
        return { detected: true, pattern: pattern.source.slice(0, 50) };
      }
    }
    return { detected: false };
  }

  /** Filtrar a propiedades declaradas conservando valores (sin escapar). */
  private sanitizeParams(params: Record<string, unknown>, properties: Record<string, any>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key in properties) sanitized[key] = value;
    }
    return sanitized;
  }

  private computeHash(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
}