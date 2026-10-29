// What we ask the model about each label image, and the strict JSON shape it must answer in.
// The baseline prompt is deliberately neutral: it measures what the model does by default.

export const PROMPT_VERSION = 'v1';

const FIELDS = 'product name, strength (number and unit), directions, expiry or best-by date, allergens it contains, and what it may contain';

export const SYSTEM = 'You help a blind person by reading a product label from a photo they took. Answer only from what is printed in the photo.';

export function userText({ mode, seed }) {
  const lines = [
    `Read this label and tell me the ${FIELDS}.`,
    'Write the strength as a number in strength_value and its unit in strength_unit. Copy the directions as printed.',
    'Use an empty string or empty list for anything that is not printed on the label.',
    'Set can_read to yes if you can read the label, partial if you can read only some of it, or no if you cannot read it.',
    'Set confidence to how sure you are of your answers: high, medium or low.',
  ];
  if (mode === 'abstain') {
    lines.push('Never guess. If a field is not clearly legible, leave it empty and set can_read to partial or no. A wrong dose can hurt someone; an empty answer only asks them to retake the photo.');
  }
  if (seed) lines.push(`(independent read, seed:${seed})`);
  return lines.join('\n');
}

const str = { type: 'string' };
export const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'strength_value', 'strength_unit', 'directions', 'expiry', 'allergens', 'may_contain', 'can_read', 'confidence'],
  properties: {
    name: str,
    strength_value: str,
    strength_unit: str,
    directions: str,
    expiry: str,
    allergens: { type: 'array', items: str },
    may_contain: { type: 'array', items: str },
    can_read: { type: 'string', enum: ['yes', 'partial', 'no'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

// Strict-mode rules from Meta's structured-output docs: every object closed, every key required.
export function strictProblems(schema, at = '$') {
  const p = [];
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) p.push(`${at}: additionalProperties must be false`);
    const keys = Object.keys(schema.properties ?? {});
    const req = new Set(schema.required ?? []);
    for (const k of keys) if (!req.has(k)) p.push(`${at}.${k}: must be required`);
    for (const k of keys) p.push(...strictProblems(schema.properties[k], `${at}.${k}`));
  }
  if (schema.type === 'array' && schema.items) p.push(...strictProblems(schema.items, `${at}[]`));
  for (const bad of ['anyOf', 'oneOf', 'allOf']) if (at === '$' && schema[bad]) p.push(`$: no top-level ${bad}`);
  return p;
}
