import type { z } from "zod";

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return zodTypeToJson(schema);
}

/** Return a semantically equivalent JSON value with object keys sorted.
 *  Provider SDKs serialize tool schemas using object insertion order; raw
 *  schemas from MCP servers or custom callers can differ only by key order and
 *  still produce different prompt-cache bytes. Arrays stay in caller order
 *  except for JSON Schema set-like arrays whose ordering is semantically
 *  irrelevant (`required`, `enum`, and string-array `type`). */
export function canonicalizeJsonSchema<T>(value: T): T {
  return canonicalizeJsonSchemaValue(value) as T;
}

function canonicalizeJsonSchemaValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => canonicalizeJsonSchemaValue(entry));
    if (key === "required" && mapped.every((entry): entry is string => typeof entry === "string")) {
      return [...mapped].sort((a, b) => a.localeCompare(b));
    }
    if (key === "type" && mapped.every((entry): entry is string => typeof entry === "string")) {
      return [...mapped].sort((a, b) => a.localeCompare(b));
    }
    if (key === "enum") {
      return [...mapped].sort(compareJsonSchemaSetEntries);
    }
    if (isSchemaCombinatorArrayKey(key)) {
      return [...mapped].sort(compareJsonSchemaSetEntries);
    }
    return mapped;
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalizeJsonSchemaValue((value as Record<string, unknown>)[key], key);
  }
  return out;
}

function compareJsonSchemaSetEntries(a: unknown, b: unknown): number {
  return jsonSetEntrySortKey(a).localeCompare(jsonSetEntrySortKey(b));
}

function isSchemaCombinatorArrayKey(key: string | undefined): boolean {
  return key === "anyOf" || key === "oneOf" || key === "allOf";
}

function jsonSetEntrySortKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function zodTypeToJson(schema: z.ZodType): Record<string, unknown> {
  return withSchemaMetadata(schema, zodTypeToJsonInner(schema));
}

function zodTypeToJsonInner(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as any)._def;
  // Support both Zod v3 (typeName) and Zod v4 (type)
  const typeName: string = def.typeName ?? def.type ?? "";

  switch (typeName) {
    // Zod v4 uses lowercase type names; v3 uses "ZodObject" etc.
    case "ZodObject":
    case "object": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const propertySchema = value as z.ZodType;
        const unwrapped = unwrapOptional(propertySchema);
        properties[key] = withSchemaMetadata(propertySchema, zodTypeToJson(unwrapped.schema));
        if (!unwrapped.optional) {
          required.push(key);
        }
      }
      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...objectAdditionalProperties(def),
      };
    }
    case "ZodString":
    case "string":
      return { type: "string", ...stringChecks(def) };
    case "ZodNumber":
    case "number":
      return {
        type: isIntegerNumber(def) ? "integer" : "number",
        ...numberChecks(def),
      };
    case "ZodBoolean":
    case "boolean":
      return { type: "boolean" };
    case "ZodArray":
    case "array": {
      // v3: def.type (the element schema); v4: def.element
      const elementSchema = def.element ?? def.type;
      return { type: "array", items: zodTypeToJson(elementSchema), ...arrayChecks(def) };
    }
    case "ZodEnum":
    case "enum": {
      // v3: def.values (array); v4: def.entries (object)
      const enumValues = Array.isArray(def.values)
        ? def.values
        : Object.keys(def.entries ?? {});
      return { type: "string", enum: enumValues };
    }
    case "ZodLiteral":
    case "literal": {
      const values = Array.isArray(def.values)
        ? def.values
        : [def.value];
      const validValues = values.filter((value: unknown) => value !== undefined);
      if (validValues.length === 1) {
        return { const: validValues[0] };
      }
      return { enum: validValues };
    }
    case "ZodUnion":
    case "union": {
      const options = (def.options ?? []) as z.ZodType[];
      return { anyOf: options.map((option) => zodTypeToJson(option)) };
    }
    case "ZodNullable":
    case "nullable": {
      const inner = zodTypeToJson(def.innerType);
      const type = inner.type;
      if (typeof type === "string") {
        return { ...inner, type: [type, "null"] };
      }
      if (Array.isArray(type)) {
        return { ...inner, type: [...new Set([...type, "null"])] };
      }
      return { anyOf: [inner, { type: "null" }] };
    }
    case "ZodOptional":
    case "optional":
      return zodTypeToJson(def.innerType);
    case "ZodDefault":
    case "default": {
      // z.X.default(value) → inner schema's JSON shape, with `default` set.
      const inner = zodTypeToJson(def.innerType);
      const defaultValue = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
      return defaultValue !== undefined ? { ...inner, default: defaultValue } : inner;
    }
    case "ZodRecord":
    case "record": {
      // z.record(keyType, valueType) → JSON schema "object with additionalProperties"
      // v3 and v4 both expose the value schema as def.valueType. The key type is
      // always string for JSON serialization purposes (JSON object keys can't be
      // anything else), so we ignore def.keyType.
      const valueSchema = def.valueType;
      return {
        type: "object",
        additionalProperties: valueSchema ? zodTypeToJson(valueSchema) : true,
      };
    }
    case "ZodAny":
    case "any":
    case "ZodUnknown":
    case "unknown":
      return {};
    case "ZodNull":
    case "null":
      return { type: "null" };
    default:
      // Unhandled zod types fall through to "any". We deliberately do NOT
      // console.warn here: zapcode runs in capture-stdout TUI mode where
      // console writes bypass the stdout interceptor and overpaint the
      // prompt area. Returning `{}` is safer than lying that an unknown schema
      // is a string; the real Zod validator still enforces the contract at
      // tool execution time.
      return {};
  }
}

function withSchemaMetadata(schema: z.ZodType, json: Record<string, unknown>): Record<string, unknown> {
  const def = (schema as any)._def;
  const description = (schema as any).description ?? def?.description;
  if (typeof description !== "string" || description.length === 0 || "description" in json) {
    return json;
  }
  return { ...json, description };
}

function unwrapOptional(schema: z.ZodType): {
  schema: z.ZodType;
  optional: boolean;
} {
  const def = (schema as any)._def;
  const typeName: string = def.typeName ?? def.type ?? "";
  if (typeName === "ZodOptional" || typeName === "optional") {
    return { schema: def.innerType, optional: true };
  }
  return { schema, optional: false };
}

function objectAdditionalProperties(def: any): Record<string, unknown> {
  const catchall = def.catchall as z.ZodType | undefined;
  if (!catchall) return {};
  const catchallDef = (catchall as any)._def;
  const typeName: string = catchallDef?.typeName ?? catchallDef?.type ?? "";
  if (typeName === "ZodNever" || typeName === "never") {
    return { additionalProperties: false };
  }
  if (typeName === "ZodUnknown" || typeName === "unknown" || typeName === "ZodAny" || typeName === "any") {
    return { additionalProperties: true };
  }
  return { additionalProperties: zodTypeToJson(catchall) };
}

function stringChecks(def: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const check of def.checks ?? []) {
    const checkDef = check?._zod?.def ?? check;
    switch (checkDef?.check ?? checkDef?.kind) {
      case "min_length":
      case "min":
        if (typeof (checkDef.minimum ?? checkDef.value) === "number") {
          out.minLength = checkDef.minimum ?? checkDef.value;
        }
        break;
      case "max_length":
      case "max":
        if (typeof (checkDef.maximum ?? checkDef.value) === "number") {
          out.maxLength = checkDef.maximum ?? checkDef.value;
        }
        break;
      case "string_format":
        if (checkDef.format === "regex" && checkDef.pattern instanceof RegExp) {
          out.pattern = checkDef.pattern.source;
        } else if (typeof checkDef.format === "string") {
          out.format = checkDef.format;
        }
        break;
      case "regex":
        if (checkDef.regex instanceof RegExp) out.pattern = checkDef.regex.source;
        break;
    }
  }
  return out;
}

function numberChecks(def: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const check of def.checks ?? []) {
    const checkDef = check?._zod?.def ?? check;
    switch (checkDef?.check ?? checkDef?.kind) {
      case "greater_than": {
        const key = checkDef.inclusive === false ? "exclusiveMinimum" : "minimum";
        if (typeof checkDef.value === "number") out[key] = checkDef.value;
        break;
      }
      case "less_than": {
        const key = checkDef.inclusive === false ? "exclusiveMaximum" : "maximum";
        if (typeof checkDef.value === "number") out[key] = checkDef.value;
        break;
      }
      case "min":
        if (typeof checkDef.value === "number") out.minimum = checkDef.value;
        break;
      case "max":
        if (typeof checkDef.value === "number") out.maximum = checkDef.value;
        break;
    }
  }
  return out;
}

function arrayChecks(def: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const check of def.checks ?? []) {
    const checkDef = check?._zod?.def ?? check;
    switch (checkDef?.check ?? checkDef?.kind) {
      case "min_length":
      case "min":
        if (typeof (checkDef.minimum ?? checkDef.value) === "number") {
          out.minItems = checkDef.minimum ?? checkDef.value;
        }
        break;
      case "max_length":
      case "max":
        if (typeof (checkDef.maximum ?? checkDef.value) === "number") {
          out.maxItems = checkDef.maximum ?? checkDef.value;
        }
        break;
    }
  }
  return out;
}

function isIntegerNumber(def: any): boolean {
  if (def.format === "safeint" || def.format === "int32" || def.format === "int64") return true;
  if (def.check === "number_format" && typeof def.format === "string" && def.format.includes("int")) return true;
  for (const check of def.checks ?? []) {
    const checkDef = check?._zod?.def ?? check;
    if (
      checkDef?.check === "number_format" &&
      typeof checkDef?.format === "string" &&
      checkDef.format.includes("int")
    ) {
      return true;
    }
  }
  return false;
}
