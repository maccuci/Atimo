import { getModel } from "./models";

/*
 * Token math, in one leaf module.
 *
 * Every surface that budgets, prices or displays a token count reads it from
 * here — the composer, the usage meter, the reference preview, the skills
 * views. They all describe the same prompt, so an estimator that drifted
 * between two of them would show the user two different numbers for one turn.
 */

/** ~4 chars per token, close enough for budgeting UI. */
export const estimateTokens = (text: string) =>
  Math.max(1, Math.ceil(text.length / 4));

/** Budget rule from project memory: never exceed 30% of the model window. */
export const BUDGET_RATIO = 0.3;

/** The retrieval ceiling for a model, in tokens. */
export function contextBudget(modelId: string): number {
  return Math.floor(getModel(modelId).contextWindow * BUDGET_RATIO);
}
