import { describe, it, expect } from "bun:test"
import { z } from "zod"
import { canonicalizeJsonSchema, zodToJsonSchema } from "../../tools/schema.js"

describe("zodToJsonSchema", () => {
  it("converts z.record(string, string) to object with additionalProperties", () => {
    const schema = z.object({
      headers: z.record(z.string(), z.string()).optional(),
    })
    const json = zodToJsonSchema(schema) as any
    expect(json.properties.headers).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
    })
  })

  it("converts z.record(string, number) with typed value", () => {
    const schema = z.object({
      counts: z.record(z.string(), z.number()),
    })
    const json = zodToJsonSchema(schema) as any
    expect(json.properties.counts).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    })
    expect(json.required).toContain("counts")
  })

  it("handles common types (string/number/boolean/array/enum/optional)", () => {
    const schema = z.object({
      s: z.string(),
      n: z.number(),
      b: z.boolean(),
      a: z.array(z.string()),
      e: z.enum(["x", "y"]),
      o: z.string().optional(),
    })
    const json = zodToJsonSchema(schema) as any
    expect(json.properties.s).toEqual({ type: "string" })
    expect(json.properties.n).toEqual({ type: "number" })
    expect(json.properties.b).toEqual({ type: "boolean" })
    expect(json.properties.a).toEqual({ type: "array", items: { type: "string" } })
    expect(json.properties.e).toEqual({ type: "string", enum: ["x", "y"] })
    expect(json.properties.o).toEqual({ type: "string" })
    expect(json.required).toEqual(["s", "n", "b", "a", "e"]) // o optional
  })

  it("converts literal, union, nullable, and integer schemas", () => {
    const schema = z.object({
      literal: z.literal("x"),
      union: z.union([z.string(), z.number()]),
      nullable: z.string().nullable(),
      int: z.number().int(),
    })
    const json = zodToJsonSchema(schema) as any
    expect(json.properties.literal).toEqual({ const: "x" })
    expect(json.properties.union).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    })
    expect(json.properties.nullable).toEqual({ type: ["string", "null"] })
    expect(json.properties.int).toEqual({ type: "integer" })
  })

  it("preserves descriptions through plain and wrapped schemas", () => {
    const schema = z.object({
      plain: z.string().describe("Visible to the model"),
      optional: z.string().optional().describe("Still visible when optional"),
    }).describe("Root object")
    const json = zodToJsonSchema(schema) as any

    expect(json.description).toBe("Root object")
    expect(json.properties.plain).toEqual({
      type: "string",
      description: "Visible to the model",
    })
    expect(json.properties.optional).toEqual({
      type: "string",
      description: "Still visible when optional",
    })
  })

  it("projects common string, number, and array checks into JSON Schema", () => {
    const schema = z.object({
      name: z.string().min(2).max(12).regex(/^[a-z_]+$/),
      email: z.string().email(),
      count: z.number().gt(0).lte(10),
      items: z.array(z.string()).min(1).max(3),
    })
    const json = zodToJsonSchema(schema) as any

    expect(json.properties.name).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 12,
      pattern: "^[a-z_]+$",
    })
    expect(json.properties.email).toEqual({
      type: "string",
      format: "email",
    })
    expect(json.properties.count).toEqual({
      type: "number",
      exclusiveMinimum: 0,
      maximum: 10,
    })
    expect(json.properties.items).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    })
  })

  it("marks strict objects as disallowing additional properties", () => {
    const schema = z.object({
      nested: z.object({ a: z.string() }).strict(),
    })
    const json = zodToJsonSchema(schema) as any
    expect(json.properties.nested).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    })
  })

  it("falls back to any-schema for unknown Zod types instead of lying as string", () => {
    const fake = { _def: { type: "future_zod_type" } } as unknown as z.ZodType
    expect(zodToJsonSchema(fake)).toEqual({})
  })
})

describe("canonicalizeJsonSchema", () => {
  it("sorts nested object keys and set-like required arrays", () => {
    const schema = {
      zLast: true,
      properties: {
        beta: { type: "string", description: "B" },
        alpha: { description: "A", type: "string" },
      },
      required: ["beta", "alpha"],
      type: "object",
    }

    const canonical = canonicalizeJsonSchema(schema)

    expect(Object.keys(canonical)).toEqual(["properties", "required", "type", "zLast"])
    expect(Object.keys(canonical.properties)).toEqual(["alpha", "beta"])
    expect(Object.keys(canonical.properties.alpha)).toEqual(["description", "type"])
    expect(canonical.required).toEqual(["alpha", "beta"])
  })

  it("sorts schema combinator arrays while preserving ordinary arrays", () => {
    const schema = {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          required: ["z", "a"],
          properties: {
            z: { type: "string" },
            a: { type: "number" },
          },
        },
      ],
      oneOf: [{ const: "z" }, { const: "a" }],
      allOf: [{ title: "Z" }, { title: "A" }],
      enum: ["z", "a"],
      examples: ["z", "a"],
      type: ["string", "null"],
    }

    const canonical = canonicalizeJsonSchema(schema)

    expect(canonical.anyOf[0].required).toEqual(["a", "z"])
    expect(canonical.anyOf[1]).toEqual({ type: "string" })
    expect(canonical.oneOf).toEqual([{ const: "a" }, { const: "z" }])
    expect(canonical.allOf).toEqual([{ title: "A" }, { title: "Z" }])
    expect(canonical.enum).toEqual(["a", "z"])
    expect(canonical.examples).toEqual(["z", "a"])
    expect(canonical.type).toEqual(["null", "string"])
  })

  it("sorts object-valued enum entries after canonicalizing their keys", () => {
    const schema = {
      enum: [
        { z: 1, a: 2 },
        { b: true },
      ],
    }

    const canonical = canonicalizeJsonSchema(schema)

    expect(canonical.enum).toEqual([
      { a: 2, z: 1 },
      { b: true },
    ])
  })
})
