// Language catalog for the live translation app.
//
// - `code` is the ISO 639-1 code used in API requests and translation prompts
// - `speech` is the BCP-47 tag passed to the browser SpeechRecognition API
//   (recognition support varies by browser; unsupported tags fall back to typing)
// - `m2m100` marks languages supported by the Workers AI fallback model
//   (@cf/meta/m2m100-1.2b), used when no Anthropic API key is configured
// - `rtl` marks right-to-left scripts for display

export interface Language {
  code: string;
  name: string;
  nativeName: string;
  speech: string;
  m2m100: boolean;
  rtl?: boolean;
}

export const LANGUAGES: Language[] = [
  { code: 'uz', name: 'Uzbek', nativeName: 'Oʻzbekcha', speech: 'uz-UZ', m2m100: true },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', speech: 'ru-RU', m2m100: true },
  {
    code: 'ht',
    name: 'Haitian Creole',
    nativeName: 'Kreyòl ayisyen',
    speech: 'ht-HT',
    m2m100: true,
  },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', speech: 'ml-IN', m2m100: true },
  { code: 'en', name: 'English', nativeName: 'English', speech: 'en-US', m2m100: true },
  { code: 'es', name: 'Spanish', nativeName: 'Español', speech: 'es-ES', m2m100: true },
  { code: 'fr', name: 'French', nativeName: 'Français', speech: 'fr-FR', m2m100: true },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', speech: 'pt-BR', m2m100: true },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', speech: 'ar-SA', m2m100: true, rtl: true },
  { code: 'zh', name: 'Chinese (Mandarin)', nativeName: '中文', speech: 'zh-CN', m2m100: true },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', speech: 'hi-IN', m2m100: true },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', speech: 'bn-IN', m2m100: true },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', speech: 'ta-IN', m2m100: true },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', speech: 'te-IN', m2m100: true },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', speech: 'ur-PK', m2m100: true, rtl: true },
  {
    code: 'fa',
    name: 'Persian (Farsi)',
    nativeName: 'فارسی',
    speech: 'fa-IR',
    m2m100: true,
    rtl: true,
  },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', speech: 'tr-TR', m2m100: true },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', speech: 'uk-UA', m2m100: true },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', speech: 'pl-PL', m2m100: true },
  { code: 'de', name: 'German', nativeName: 'Deutsch', speech: 'de-DE', m2m100: true },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', speech: 'it-IT', m2m100: true },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', speech: 'vi-VN', m2m100: true },
  { code: 'ko', name: 'Korean', nativeName: '한국어', speech: 'ko-KR', m2m100: true },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', speech: 'ja-JP', m2m100: true },
  { code: 'tl', name: 'Tagalog (Filipino)', nativeName: 'Tagalog', speech: 'fil-PH', m2m100: true },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', speech: 'sw-KE', m2m100: true },
  { code: 'am', name: 'Amharic', nativeName: 'አማርኛ', speech: 'am-ET', m2m100: true },
  { code: 'so', name: 'Somali', nativeName: 'Soomaali', speech: 'so-SO', m2m100: true },
  { code: 'ps', name: 'Pashto', nativeName: 'پښتو', speech: 'ps-AF', m2m100: true, rtl: true },
  { code: 'ne', name: 'Nepali', nativeName: 'नेपाली', speech: 'ne-NP', m2m100: true },
  { code: 'my', name: 'Burmese', nativeName: 'မြန်မာဘာသာ', speech: 'my-MM', m2m100: true },
  { code: 'km', name: 'Khmer', nativeName: 'ខ្មែរ', speech: 'km-KH', m2m100: true },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', speech: 'th-TH', m2m100: true },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', speech: 'id-ID', m2m100: true },
  { code: 'ka', name: 'Georgian', nativeName: 'ქართული', speech: 'ka-GE', m2m100: true },
  { code: 'hy', name: 'Armenian', nativeName: 'Հայերեն', speech: 'hy-AM', m2m100: true },
  { code: 'kk', name: 'Kazakh', nativeName: 'Қазақша', speech: 'kk-KZ', m2m100: true },
  { code: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycanca', speech: 'az-AZ', m2m100: true },
  { code: 'mn', name: 'Mongolian', nativeName: 'Монгол', speech: 'mn-MN', m2m100: true },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', speech: 'el-GR', m2m100: true },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', speech: 'he-IL', m2m100: true, rtl: true },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', speech: 'ro-RO', m2m100: true },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', speech: 'nl-NL', m2m100: true },
];

const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));

export function getLanguage(code: string): Language | undefined {
  return byCode.get(code);
}

export function isSupported(code: string): boolean {
  return byCode.has(code);
}
