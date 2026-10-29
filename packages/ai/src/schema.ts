import { z, type ZodType } from 'zod';

type Json = Record<string, unknown>;

/**
 * Converts a Zod schema to the JSON Schema subset accepted by both OpenAI
 * strict structured outputs and Anthropic `output_config.format`:
 * every object closed (`additionalProperties: false`) with all keys required.
 */
export function toStrictJsonSchema(schema: ZodType): Json {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Json;
  delete raw.$schema;
  return normalize(raw) as Json;
}

const DROP = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'default']);

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (DROP.has(k)) continue;
    out[k] = normalize(v);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Json);
  }
  return out;
}

/** Extracts the first JSON object from a text response (fallback path for models without structured outputs). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in response');
  return JSON.parse(candidate.slice(start, end + 1));
}
