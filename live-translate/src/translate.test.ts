import { describe, expect, it } from 'vitest';
import {
  MAX_TARGETS,
  MAX_TEXT_LENGTH,
  buildUserMessage,
  parseTranslationResponse,
  validateRequest,
  type TranslateRequest,
} from './translate';
import { LANGUAGES, getLanguage, isSupported } from './languages';

function expectValid(body: unknown): TranslateRequest {
  const result = validateRequest(body);
  if (!result.ok) throw new Error(`expected request to validate, got: ${result.error}`);
  return result.req;
}

describe('validateRequest', () => {
  it('accepts a valid request', () => {
    const req = expectValid({ text: 'Hello', targets: ['uz', 'ru'] });
    expect(req.source).toBe('auto');
    expect(req.partial).toBe(false);
    expect(req.targets).toEqual(['uz', 'ru']);
  });

  it('accepts an explicit source and partial flag', () => {
    const req = expectValid({ text: 'Hello', targets: ['ht'], source: 'en', partial: true });
    expect(req.source).toBe('en');
    expect(req.partial).toBe(true);
  });

  it('rejects missing text', () => {
    const result = validateRequest({ targets: ['uz'] });
    expect(result.ok).toBe(false);
  });

  it('rejects empty text', () => {
    const result = validateRequest({ text: '   ', targets: ['uz'] });
    expect(result.ok).toBe(false);
  });

  it('rejects text over the length limit', () => {
    const result = validateRequest({ text: 'a'.repeat(MAX_TEXT_LENGTH + 1), targets: ['uz'] });
    expect(result.ok).toBe(false);
  });

  it('rejects missing or empty targets', () => {
    expect(validateRequest({ text: 'Hi' }).ok).toBe(false);
    expect(validateRequest({ text: 'Hi', targets: [] }).ok).toBe(false);
  });

  it('rejects too many targets', () => {
    const targets = LANGUAGES.slice(0, MAX_TARGETS + 1).map((l) => l.code);
    expect(validateRequest({ text: 'Hi', targets }).ok).toBe(false);
  });

  it('rejects unsupported target and source languages', () => {
    expect(validateRequest({ text: 'Hi', targets: ['xx'] }).ok).toBe(false);
    expect(validateRequest({ text: 'Hi', targets: ['uz'], source: 'xx' }).ok).toBe(false);
  });

  it('rejects non-object bodies', () => {
    expect(validateRequest(null).ok).toBe(false);
    expect(validateRequest('hello').ok).toBe(false);
  });
});

describe('buildUserMessage', () => {
  it('includes target language names and the text', () => {
    const msg = buildUserMessage({ text: 'Good morning', targets: ['uz', 'ml'], source: 'auto' });
    expect(msg).toContain('uz (Uzbek)');
    expect(msg).toContain('ml (Malayalam)');
    expect(msg).toContain('Good morning');
    expect(msg).toContain('detect automatically');
  });

  it('includes explicit source and partial marker', () => {
    const msg = buildUserMessage({ text: 'Bonjou', targets: ['en'], source: 'ht', partial: true });
    expect(msg).toContain('ht (Haitian Creole)');
    expect(msg).toContain('PARTIAL');
  });
});

describe('parseTranslationResponse', () => {
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({
      detected_source: 'en',
      translations: [
        { lang: 'uz', text: 'Salom' },
        { lang: 'ru', text: 'Привет' },
      ],
    });
    const result = parseTranslationResponse(raw, ['uz', 'ru']);
    expect(result.detectedSource).toBe('en');
    expect(result.translations).toEqual({ uz: 'Salom', ru: 'Привет' });
  });

  it('ignores entries for languages that were not requested', () => {
    const raw = JSON.stringify({
      detected_source: 'en',
      translations: [
        { lang: 'uz', text: 'Salom' },
        { lang: 'fr', text: 'Salut' },
      ],
    });
    const result = parseTranslationResponse(raw, ['uz']);
    expect(result.translations).toEqual({ uz: 'Salom' });
  });

  it('tolerates a missing target as long as at least one is present', () => {
    const raw = JSON.stringify({
      detected_source: 'en',
      translations: [{ lang: 'uz', text: 'Salom' }],
    });
    const result = parseTranslationResponse(raw, ['uz', 'ml']);
    expect(result.translations).toEqual({ uz: 'Salom' });
  });

  it('throws when no requested target is present', () => {
    const raw = JSON.stringify({
      detected_source: 'en',
      translations: [{ lang: 'fr', text: 'Salut' }],
    });
    expect(() => parseTranslationResponse(raw, ['uz'])).toThrow('no requested target languages');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTranslationResponse('not json', ['uz'])).toThrow('not valid JSON');
  });
});

describe('languages', () => {
  it('includes the requested core languages', () => {
    for (const code of ['uz', 'ru', 'ht', 'ml']) {
      expect(isSupported(code)).toBe(true);
    }
  });

  it('has unique codes', () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('looks up languages by code', () => {
    expect(getLanguage('uz')?.name).toBe('Uzbek');
    expect(getLanguage('xx')).toBeUndefined();
  });
});
