import { describe, expect, it } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("cleanJSONSchemaForAntigravity: array items schema compatibility", () => {
  it("ensures nested array items.items is populated when where is an array of arrays", () => {
    // Exact schema shape from the user's error:
    // GenerateContentRequest.tools[0].function_declarations[1].parameters.properties[query].properties[where].items.items: missing field.
    const inputSchema = {
      type: "object",
      properties: {
        query: {
          type: "object",
          properties: {
            where: {
              type: "array",
              items: {
                type: "array"
              }
            }
          }
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.query.properties.where.type).toBe("array");
    expect(cleaned.properties.query.properties.where.items).toBeDefined();
    expect(cleaned.properties.query.properties.where.items.type).toBe("array");
    expect(cleaned.properties.query.properties.where.items.items).toBeDefined();
    expect(cleaned.properties.query.properties.where.items.items.type).toBe("string");
  });

  it("normalizes array schemas without items to have default string items", () => {
    const inputSchema = {
      type: "object",
      properties: {
        tags: {
          type: "array"
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.tags.type).toBe("array");
    expect(cleaned.properties.tags.items).toEqual({ type: "string" });
  });

  it("normalizes array schemas with empty items object to string items", () => {
    const inputSchema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {}
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.tags.type).toBe("array");
    expect(cleaned.properties.tags.items).toEqual({ type: "string" });
  });

  it("converts JSON Schema tuple items (array of schemas) to a single schema object", () => {
    const inputSchema = {
      type: "object",
      properties: {
        filter: {
          type: "array",
          items: [
            { type: "number", description: "min" },
            { type: "number", description: "max" }
          ]
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.filter.type).toBe("array");
    expect(Array.isArray(cleaned.properties.filter.items)).toBe(false);
    expect(cleaned.properties.filter.items.type).toBe("number");
  });

  it("handles deep 3D nested arrays recursively", () => {
    const inputSchema = {
      type: "object",
      properties: {
        tensor: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "array"
            }
          }
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.tensor.items.items.items).toEqual({ type: "string" });
  });

  it("infers type=array when items exists without explicit type", () => {
    const inputSchema = {
      type: "object",
      properties: {
        entries: {
          items: {
            type: "string"
          }
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.entries.type).toBe("array");
    expect(cleaned.properties.entries.items).toEqual({ type: "string" });
  });

  it("does not corrupt properties map when a property is named items", () => {
    const inputSchema = {
      type: "object",
      properties: {
        items: {
          type: "string",
          description: "line items"
        },
        cartId: {
          type: "string"
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.type).toBeUndefined();
    expect(Object.keys(cleaned.properties).sort()).toEqual(["cartId", "items"].sort());
    expect(cleaned.properties.items.type).toBe("string");
  });

  it("selects first valid object schema in tuple when earlier entries are null or primitives", () => {
    const inputSchema = {
      type: "object",
      properties: {
        tuple: {
          type: "array",
          items: [null, false, { type: "number", description: "numeric value" }]
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.tuple.items).toEqual({
      type: "number",
      description: "numeric value"
    });
  });

  it("removes unsupported prefixItems and uniqueItems keywords", () => {
    const inputSchema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          uniqueItems: true,
          prefixItems: [{ type: "string" }],
          items: {
            type: "string"
          }
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.data.uniqueItems).toBeUndefined();
    expect(cleaned.properties.data.prefixItems).toBeUndefined();
    expect(cleaned.properties.data.items).toEqual({ type: "string" });
  });

  it("harvests prefixItems when items is missing before prefixItems is stripped", () => {
    const inputSchema = {
      type: "object",
      properties: {
        coordinates: {
          type: "array",
          prefixItems: [{ type: "number", description: "latitude" }, { type: "number", description: "longitude" }]
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.coordinates.type).toBe("array");
    expect(cleaned.properties.coordinates.items).toEqual({
      type: "number",
      description: "latitude"
    });
    expect(cleaned.properties.coordinates.prefixItems).toBeUndefined();
  });

  it("removes additionalItems, unevaluatedItems, contains, minContains, maxContains", () => {
    const inputSchema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          additionalItems: false,
          unevaluatedItems: false,
          contains: { type: "string" },
          minContains: 1,
          maxContains: 5,
          items: {
            type: "string"
          }
        }
      }
    };

    const cleaned = cleanJSONSchemaForAntigravity(inputSchema);

    expect(cleaned.properties.data.additionalItems).toBeUndefined();
    expect(cleaned.properties.data.unevaluatedItems).toBeUndefined();
    expect(cleaned.properties.data.contains).toBeUndefined();
    expect(cleaned.properties.data.minContains).toBeUndefined();
    expect(cleaned.properties.data.maxContains).toBeUndefined();
    expect(cleaned.properties.data.items).toEqual({ type: "string" });
  });
});
