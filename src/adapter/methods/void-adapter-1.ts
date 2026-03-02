import { createSseTransformer } from '../sse.js';
import { normalizePayload } from '../normalize.js';
import type { AdapterMethod } from './types.js';

export const voidAdapter1Method: AdapterMethod = {
  name: 'void-adapter-1',
  createSseTransformer,
  normalizePayload,
};

