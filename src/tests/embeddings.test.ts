import { afterEach, describe, expect, test } from "bun:test";
import {
  cachedQuery,
  decodeVector,
  disableEmbeddings,
  dot,
  embedPassages,
  embedQuery,
  embeddingsReady,
  encodeVector,
  baselineOf,
  fuse,
  relevance,
  resetEmbeddings,
  setEmbedderForTests,
  subscribeEmbeddings,
} from "../lib/embeddings";

/*
 * The seam, not the model.
 *
 * What is worth testing here is everything the model does not do: the encoding
 * both sides agree on, the calibration that turns a cosine into something a UI
 * can print, the fusion rule, and — most of all — the cache that lets `compose`
 * stay synchronous. A wrong answer from the model is a worse search; a wrong
 * answer from any of these is a search that silently stops working.
 */

afterEach(() => {
  resetEmbeddings();
  setEmbedderForTests(null);
});

describe("the wire format", () => {
  test("a vector survives the round trip Rust encodes it for", () => {
    const decoded = decodeVector(encodeVector([3, 4]));
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toBeCloseTo(0.6, 5);
    expect(decoded[1]).toBeCloseTo(0.8, 5);
  });

  test("encoding normalises, so similarity is a plain dot product", () => {
    // The reason the hot loop has no square roots in it. If either side stopped
    // normalising, every score in the app would be off by a factor nobody could
    // see — the ranking would still look plausible and be wrong.
    const a = decodeVector(encodeVector([2, 0, 0]));
    const b = decodeVector(encodeVector([9, 0, 0]));
    expect(dot(a, b)).toBeCloseTo(1, 5);
  });

  test("vectors of different widths score zero rather than throwing", () => {
    // What a model change looks like from in here. Refusing loudly would take
    // the search box down; scoring zero degrades it to lexical.
    expect(dot(decodeVector(encodeVector([1, 0])), decodeVector(encodeVector([1, 0, 0])))).toBe(0);
  });
});

/*
 * The measured shape of this model, transcribed from
 * `embeddings.rs::portuguese_answer_clears_its_corpus_baseline` — the language
 * the calibration has to work hardest in. Every number below is what the query
 * "como funciona o login" actually scored against eight real passages on
 * `multilingual-e5-base`: one answer about session cookies, seven about other
 * things, all inside a 0.054-wide band.
 */
const MEASURED = {
  answer: 0.847,
  postgres: 0.824,
  latency: 0.817,
  shipping: 0.811,
  kitchen: 0.804,
  fruit: 0.8,
  meeting: 0.8,
  rain: 0.793,
};

describe("calibration", () => {
  const corpus = Object.values(MEASURED);

  test("a corpus sets its own baseline", () => {
    // Not a constant. What "unremarkable" scores at moves with the language, the
    // length and the register of what is being asked.
    const baseline = baselineOf(corpus)!;
    expect(baseline.median).toBeCloseTo(0.8075, 4);
    expect(baseline.weight).toBe(1);
  });

  test("the answer clears the noise it used to sit beside", () => {
    const baseline = baselineOf(corpus);

    // The honest Portuguese numbers, and the property that matters in them: the
    // answer reads at about half strength — that is the model, not the math —
    // but more than double its nearest noise, and everything at or under the
    // median is zero instead of the 0.1–0.2 the fixed floor used to hand it.
    const answer = relevance(MEASURED.answer, baseline);
    const noise = relevance(MEASURED.postgres, baseline);
    expect(answer).toBeGreaterThan(0.4);
    expect(answer).toBeGreaterThan(noise * 2);
    expect(noise).toBeLessThan(0.25);
    expect(relevance(MEASURED.fruit, baseline)).toBe(0);
    expect(relevance(MEASURED.rain, baseline)).toBe(0);
  });

  test("a corpus too small to have a distribution falls back", () => {
    // A median over three passages is not a baseline, it is one of the three.
    expect(baselineOf([0.8, 0.75, 0.9])).toBeNull();
    expect(relevance(0.9, null)).toBeGreaterThan(0);
    expect(relevance(0.7, null)).toBe(0);
  });

  test("the median rule fades in rather than switching on", () => {
    // The eighth passage arriving in a project used to flip every score from
    // the floor rule to the median rule in one keystroke, and the Context
    // panel's bars jumped for a reason no user could be expected to guess.
    const five = baselineOf([0.847, 0.824, 0.817, 0.8, 0.793])!;
    expect(five.weight).toBeCloseTo(0.25, 5);

    const floorOnly = relevance(0.847, null);
    const calibrated = relevance(0.847, { median: five.median, weight: 1 });
    const blended = relevance(0.847, five);
    expect(blended).toBeGreaterThan(Math.min(floorOnly, calibrated));
    expect(blended).toBeLessThan(Math.max(floorOnly, calibrated));
  });

  test("scores stay inside 0..1 whatever the baseline", () => {
    // Everything downstream — the thresholds, the palette floor, the score bars
    // — reads one scale, and a passage far above the median must not print 340%.
    expect(relevance(1, { median: 0.5, weight: 1 })).toBe(1);
    expect(relevance(0.2, { median: 0.78, weight: 1 })).toBe(0);
    // Clamped per rule, not after the mix — a blend of an off-scale rule and a
    // sane one would otherwise leak past 1.
    expect(relevance(1, { median: 0.5, weight: 0.5 })).toBe(1);
  });
});

describe("fusion", () => {
  test("a strong meaning match survives with no words in common", () => {
    // The whole point of the layer: "session cookies" against "login flow".
    expect(fuse(0, 1)).toBeGreaterThan(0.6);
  });

  test("an exact term match survives with no meaning match", () => {
    // The other half: a model trained on prose has never seen
    // `ERR_MODULE_NOT_FOUND` and puts it wherever it puts the other identifiers.
    expect(fuse(1, 0)).toBeGreaterThan(0.3);
  });

  test("no vector is not a zero vector", () => {
    // Scoring "not indexed yet" as "not relevant" would rank every honest
    // lexical hit at a third of its weight and drop the weaker two thirds under
    // the composer's thresholds.
    expect(fuse(0.8, null)).toBe(0.8);
    expect(fuse(0.8, 0)).toBeLessThan(0.8);
  });
});

/* ---------------------------------------------------------------------- */

/** One axis per text, so two texts either match completely or not at all. */
function axisEmbedder(axis: (text: string) => number) {
  return async (texts: string[]) =>
    texts.map((text) => {
      const values = [0, 0, 0, 0];
      values[axis(text)] = 1;
      return encodeVector(values);
    });
}

describe("the query cache", () => {
  test("a query not yet embedded reads as null rather than blocking", async () => {
    setEmbedderForTests(axisEmbedder(() => 0));
    // This is what keeps `compose()` synchronous. The caller falls back to
    // lexical scoring for one pass and is told when to look again.
    expect(cachedQuery("login flow")).toBeNull();
    await embedQuery("login flow");
    expect(cachedQuery("login flow")).not.toBeNull();
  });

  test("whitespace and case do not make a second entry", async () => {
    setEmbedderForTests(axisEmbedder(() => 0));
    await embedQuery("Login   Flow");
    expect(cachedQuery("login flow")).not.toBeNull();
  });

  test("a burst of callers shares one round trip", async () => {
    let calls = 0;
    setEmbedderForTests(async (texts) => {
      calls += 1;
      return texts.map(() => encodeVector([1, 0, 0, 0]));
    });

    // Every keystroke primes the same query while the previous one is still in
    // flight. Without the in-flight map that is one forward pass per keystroke.
    await Promise.all([
      embedQuery("how does login work"),
      embedQuery("how does login work"),
      embedQuery("how does login work"),
    ]);
    expect(calls).toBe(1);
  });

  test("a landed vector notifies, so a rendered result can improve", async () => {
    setEmbedderForTests(axisEmbedder(() => 0));
    let fired = 0;
    const stop = subscribeEmbeddings(() => (fired += 1));

    await embedQuery("anything");
    stop();

    // Without this the composer would warm a cache nobody re-reads, and the
    // preview would be exactly one keystroke behind its own retrieval forever.
    expect(fired).toBeGreaterThan(0);
  });

  test("a backend failure degrades to lexical rather than throwing", async () => {
    setEmbedderForTests(async () => {
      throw new Error("the model went away");
    });

    expect(await embedQuery("anything")).toBeNull();
    expect(embeddingsReady()).toBe(false);
    // And the caller can still ask, and still gets an answer it can act on.
    expect(cachedQuery("anything")).toBeNull();
  });

  test("embedding nothing does not reach the model", async () => {
    let calls = 0;
    setEmbedderForTests(async (texts) => {
      calls += 1;
      return texts.map(() => encodeVector([1]));
    });

    // The reindex loop reaches this on every idle tick, with nothing to do.
    expect(await embedPassages([])).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("switching smart search off", () => {
  test("drops cached vectors and stops calling the model until switched back on", async () => {
    const store = new Map<string, string>();
    const saved = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
    let calls = 0;
    setEmbedderForTests(async (texts) => {
      calls += 1;
      return texts.map(() => encodeVector([1]));
    });
    try {
      await embedQuery("auth");
      expect(cachedQuery("auth")).not.toBeNull();

      disableEmbeddings();
      expect(embeddingsReady()).toBe(false);
      expect(cachedQuery("auth")).toBeNull();
      expect(await embedQuery("auth")).toBeNull();
      expect(await embedPassages(["text"])).toBeNull();
      expect(calls).toBe(1);
    } finally {
      globalThis.localStorage = saved;
    }
  });
});
