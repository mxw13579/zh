import type { AdapterMethod } from './types.js';
import { voidAdapter1Method } from './void-adapter-1.js';

const METHODS = new Map<string, AdapterMethod>([[voidAdapter1Method.name, voidAdapter1Method]]);

export function getAdapterMethod(name: string): AdapterMethod | null {
  return METHODS.get(name) ?? null;
}
