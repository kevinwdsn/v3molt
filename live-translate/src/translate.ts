// Pure translation logic: prompt construction, response schema, and parsing.
// Kept free of I/O so it can be unit tested without a Workers runtime.

import { getLanguage } from './languages';

export interface TranslateRequest {
  text: string;
  targets: string[];
  source?: string; // ISO 639-1 code, or 'auto' to detect
  partial?: boolean; // true for interim speech-recognition fragments
}

export interface TranslationResult {
  detectedSource: string;
  translations: Record<string, string>;
}

export const MAX_TEXT_LENGTH = 5000;
export const MAX_TARGETS = 5;

export function validateRequest(
  body: unknown,
): { ok: true; req: TranslateRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string' || b.text.trim().length === 0) {
    return { ok: false, error: 'Missing or empty "text"' };
  }
  if (b.text.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `"text" exceeds ${MAX_TEXT_LENGTH} characters` };
  }
  if (!Array.isArray(b.targets) || b.targets.length === 0) {
    return { ok: false, error: 'Missing "targets" (array of language codes)' };
  }
  if (b.targets.length > MAX_TARGETS) {
    return { ok: false, error: `At most ${MAX_TARGETS} target languages per request` };
  }
  for (const t of b.targets) {
    if (typeof t !== 'string' || !getLanguage(t)) {
      return { ok: false, error: `Unsupported target language: ${String(t)}` };
    }
  }
  const source = typeof b.source === 'string' && b.source !== '' ? b.source : 'auto';
  if (source !== 'auto' && !getLanguage(source)) {
    return { ok: false, error: `Unsupported source language: ${source}` };
  }
  return {
    ok: true,
    req: {
      text: b.text,
      targets: b.targets as string[],
      source,
      partial: b.partial === true,
    },
  };
}

// JSON schema for structured output — guarantees a parseable response shape.
export const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    detected_source: {
      type: 'string',
      description: 'ISO 639-1 code of the source language of the input text',
    },
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lang: { type: 'string', description: 'ISO 639-1 code of the target language' },
          text: { type: 'string', description: 'The translated text' },
        },
        required: ['lang', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['detected_source', 'translations'],
  additionalProperties: false,
} as const;

export function buildSystemPrompt(): string {
  return [
    'You are a professional simultaneous interpreter powering a live translation app.',
    'Translate the user-provided text into every requested target language.',
    'Preserve meaning, tone, and register. Use natural, conversational phrasing a native speaker would use, not word-for-word renderings.',
    'Keep names, numbers, and units intact. Do not add explanations, notes, or transliterations.',
    'If the input is marked as a partial utterance (still being spoken), translate the fragment as-is without completing the sentence.',
    'Return one translation per requested target language.',
  ].join(' ');
}

export function buildUserMessage(req: TranslateRequest): string {
  const targetList = req.targets
    .map((code) => {
      const lang = getLanguage(code);
      return `${code} (${lang ? lang.name : code})`;
    })
    .join(', ');
  const sourceLine =
    req.source && req.source !== 'auto'
      ? `Source language: ${req.source} (${getLanguage(req.source)?.name ?? req.source})`
      : 'Source language: detect automatically';
  const partialLine = req.partial ? 'This is a PARTIAL utterance still being spoken.' : '';
  return [
    sourceLine,
    `Target languages: ${targetList}`,
    partialLine,
    'Text to translate:',
    req.text,
  ]
    .filter(Boolean)
    .join('\n');
}

// Parses the structured-output JSON into a TranslationResult, tolerating
// missing or extra target entries (missing targets are reported as errors upstream).
export function parseTranslationResponse(raw: string, targets: string[]): TranslationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Translation response was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Translation response was not a JSON object');
  }
  const obj = parsed as { detected_source?: unknown; translations?: unknown };
  const translations: Record<string, string> = {};
  if (Array.isArray(obj.translations)) {
    for (const entry of obj.translations) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { lang?: unknown }).lang === 'string' &&
        typeof (entry as { text?: unknown }).text === 'string'
      ) {
        const e = entry as { lang: string; text: string };
        if (targets.includes(e.lang)) {
          translations[e.lang] = e.text;
        }
      }
    }
  }
  const missing = targets.filter((t) => !(t in translations));
  if (missing.length === targets.length) {
    throw new Error('Translation response contained no requested target languages');
  }
  return {
    detectedSource: typeof obj.detected_source === 'string' ? obj.detected_source : 'auto',
    translations,
  };
}
