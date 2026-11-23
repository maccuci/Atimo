/** Missing cache usage is unknown, which is different from a measured miss. */
export function cachedPromptTokens(usage: {
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  prompt_cache_hit_tokens?: unknown;
}): number | null {
  const value = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
