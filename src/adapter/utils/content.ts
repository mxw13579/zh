import { isRecord } from './json.js';

export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }

      if (!isRecord(item)) {
        continue;
      }

      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
        continue;
      }

      if (typeof item.text === 'string') {
        parts.push(item.text);
        continue;
      }
    }
    return parts.join('');
  }

  return '';
}

