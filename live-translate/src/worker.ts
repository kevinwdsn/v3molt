// Live Translate — Cloudflare Worker
//
// Serves the static UI (via the ASSETS binding) and a small translation API:
//   GET  /api/languages  → supported language catalog
//   GET  /api/health     → which translation backend is active
//   POST /api/translate  → translate text into one or more target languages
//
// Translation backends, in priority order:
//   1. Anthropic API (ANTHROPIC_API_KEY) — high-quality LLM translation,
//      all languages, multi-target in a single request
//   2. Workers AI (AI binding) — @cf/meta/m2m100-1.2b, no API key required

import Anthropic from '@anthropic-ai/sdk';
import { LANGUAGES } from './languages';
import {
  TRANSLATION_SCHEMA,
  buildSystemPrompt,
  buildUserMessage,
  parseTranslationResponse,
  validateRequest,
  type TranslateRequest,
  type TranslationResult,
} from './translate';

interface TranslateEnv {
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  TRANSLATE_MODEL?: string;
  AI?: Ai;
}

const DEFAULT_MODEL = 'claude-opus-4-8';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function translateWithAnthropic(
  req: TranslateRequest,
  env: TranslateEnv,
): Promise<TranslationResult> {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
  });
  const response = await client.messages.create({
    model: env.TRANSLATE_MODEL || DEFAULT_MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(),
    // Translation segments are short and latency-sensitive; low effort keeps
    // responses fast without hurting quality on this task.
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: TRANSLATION_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    messages: [{ role: 'user', content: buildUserMessage(req) }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('The translation request was declined');
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return parseTranslationResponse(text, req.targets);
}

async function translateWithWorkersAi(req: TranslateRequest, ai: Ai): Promise<TranslationResult> {
  // m2m100 needs an explicit source language; default to English when detecting.
  const source = req.source && req.source !== 'auto' ? req.source : 'en';
  const translations: Record<string, string> = {};
  await Promise.all(
    req.targets.map(async (target) => {
      if (target === source) {
        translations[target] = req.text;
        return;
      }
      const result = (await ai.run('@cf/meta/m2m100-1.2b', {
        text: req.text,
        source_lang: source,
        target_lang: target,
      })) as { translated_text?: string };
      if (result.translated_text) {
        translations[target] = result.translated_text;
      }
    }),
  );
  if (Object.keys(translations).length === 0) {
    throw new Error('Workers AI returned no translations');
  }
  return { detectedSource: source, translations };
}

async function handleTranslate(request: Request, env: TranslateEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const validated = validateRequest(body);
  if (!validated.ok) {
    return json({ error: validated.error }, 400);
  }
  const req = validated.req;
  try {
    let result: TranslationResult;
    let backend: string;
    if (env.ANTHROPIC_API_KEY) {
      result = await translateWithAnthropic(req, env);
      backend = 'anthropic';
    } else if (env.AI) {
      result = await translateWithWorkersAi(req, env.AI);
      backend = 'workers-ai';
    } else {
      return json(
        {
          error:
            'No translation backend configured. Set ANTHROPIC_API_KEY or enable the Workers AI binding.',
        },
        503,
      );
    }
    return json({
      detected_source: result.detectedSource,
      translations: result.translations,
      backend,
      partial: req.partial === true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Translation failed';
    return json({ error: message }, 502);
  }
}

export default {
  async fetch(request: Request, env: TranslateEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/languages' && request.method === 'GET') {
      return json({
        languages: LANGUAGES.map(({ code, name, nativeName, speech, rtl }) => ({
          code,
          name,
          native_name: nativeName,
          speech,
          rtl: rtl === true,
        })),
      });
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      const backend = env.ANTHROPIC_API_KEY ? 'anthropic' : env.AI ? 'workers-ai' : 'none';
      return json({
        ok: backend !== 'none',
        backend,
        model:
          backend === 'anthropic'
            ? env.TRANSLATE_MODEL || DEFAULT_MODEL
            : backend === 'workers-ai'
              ? '@cf/meta/m2m100-1.2b'
              : null,
      });
    }

    if (url.pathname === '/api/translate' && request.method === 'POST') {
      return handleTranslate(request, env);
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<TranslateEnv>;
