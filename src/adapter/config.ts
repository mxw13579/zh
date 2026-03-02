export type ReasoningStrategy = 'as_reasoning_content' | 'drop' | 'as_content' | 'tagged';

export interface RuntimeConfig {
  allowOrigin: string;
  adapterAuthorization: string;
  port: number;
  reasoningStrategy: ReasoningStrategy;
}

export function loadConfig(): RuntimeConfig {
  const adapterAuthorization = (process.env.ADAPTER_AUTHORIZATION ?? '').trim();
  if (!adapterAuthorization) {
    throw new Error('ADAPTER_AUTHORIZATION is required. Example: change-me-to-a-long-random-token');
  }

  return {
    allowOrigin: (process.env.ALLOW_ORIGIN ?? '*').trim() || '*',
    adapterAuthorization,
    port: Number(process.env.PORT ?? '8787'),
    reasoningStrategy: parseStrategy(process.env.REASONING_STRATEGY),
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
