import { useMemo } from "react";
import { SEED_MODELS } from "./models";
import { FEATURED_PROVIDERS } from "./provider-ui";
import { useStore } from "./store";
import type { Model, ProviderId } from "./types";

/*
 * The models the UI may offer.
 *
 * One rule, in one place: if the provider has answered, its catalog is the
 * truth; otherwise the seed list stands in so the app is never a blank picker.
 */

export function useSelectableModels(): Model[] {
  const catalog = useStore((s) => s.catalog);
  return catalog.length ? catalog : SEED_MODELS;
}

/** Featured vendors first, then alphabetical — a stable spine for the picker. */
const PROVIDER_RANK = new Map<ProviderId, number>(
  FEATURED_PROVIDERS.map((id, i) => [id as ProviderId, i]),
);

export interface ModelGroup {
  provider: ProviderId;
  models: Model[];
}

export function groupByProvider(models: Model[]): ModelGroup[] {
  const groups = new Map<ProviderId, Model[]>();
  for (const model of models) {
    const bucket = groups.get(model.provider);
    if (bucket) bucket.push(model);
    else groups.set(model.provider, [model]);
  }

  return [...groups.entries()]
    .map(([provider, list]) => ({ provider, models: list }))
    .sort((a, b) => {
      const rankA = PROVIDER_RANK.get(a.provider) ?? Number.MAX_SAFE_INTEGER;
      const rankB = PROVIDER_RANK.get(b.provider) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.provider.localeCompare(b.provider);
    });
}

/** Grouped, then flattened back — the picker needs both shapes at once. */
export function useOrderedModels(models: Model[]): Model[] {
  return useMemo(
    () => groupByProvider(models).flatMap((group) => group.models),
    [models],
  );
}
