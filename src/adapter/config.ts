export type ReasoningStrategy = 'as_reasoning_content' | 'drop' | 'as_content' | 'tagged';

export interface RuntimeConfig {
  allowOrigin: string;
  port: number;
  reasoningStrategy: ReasoningStrategy;
  upstreamBaseUrl: string;
}

export function loadConfig(): RuntimeConfig {
  const upstreamBaseUrl = (process.env.UPSTREAM_BASE_URL ?? '').trim();
  if (!upstreamBaseUrl) {
    throw new Error('UPSTREAM_BASE_URL is required. Example: https://xx.xx.top');
  }

  return {
    allowOrigin: (process.env.ALLOW_ORIGIN ?? '*').trim() || '*',
    port: Number(process.env.PORT ?? '8787'),
    reasoningStrategy: parseStrategy(process.env.REASONING_STRATEGY),
    upstreamBaseUrl,
  };
}

function parseStrategy(raw: string | undefined): ReasoningStrategy {
  if (raw === 'drop' || raw === 'as_content' || raw === 'tagged' || raw === 'as_reasoning_content') {
    return raw;
  }
  return 'as_reasoning_content';
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

