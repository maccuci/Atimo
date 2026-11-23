import { describe, expect, test } from "bun:test";
import { resortOffsets } from "@/lib/use-flip-resort";

const tops = (entries: [string, number][]) => new Map(entries);

describe("resortOffsets", () => {
  test("a list that did not move produces no offsets", () => {
    const positions = tops([
      ["a", 0],
      ["b", 30],
      ["c", 60],
    ]);
    expect(resortOffsets(positions, positions).size).toBe(0);
  });

  test("a row promoted to the top glides down from where it was", () => {
    // c jumped from third to first; a and b each slid down one slot.
    const prev = tops([
      ["a", 0],
      ["b", 30],
      ["c", 60],
    ]);
    const next = tops([
      ["c", 0],
      ["a", 30],
      ["b", 60],
    ]);

    const offsets = resortOffsets(prev, next);
    // Positive means "start below and travel up" — c was 60px lower.
    expect(offsets.get("c")).toBe(60);
    // Negative means "start above and travel down".
    expect(offsets.get("a")).toBe(-30);
    expect(offsets.get("b")).toBe(-30);
  });

  test("new keys get no offset — they have no position to come from", () => {
    const prev = tops([["a", 0]]);
    const next = tops([
      ["fresh", 0],
      ["a", 30],
    ]);

    const offsets = resortOffsets(prev, next);
    expect(offsets.has("fresh")).toBe(false);
    expect(offsets.get("a")).toBe(-30);
  });

  test("removed keys are ignored rather than animated to nowhere", () => {
    const prev = tops([
      ["gone", 0],
      ["a", 30],
    ]);
    const next = tops([["a", 0]]);

    const offsets = resortOffsets(prev, next);
    expect(offsets.has("gone")).toBe(false);
    expect(offsets.get("a")).toBe(30);
  });

  test("sub-pixel drift is layout noise, not movement", () => {
    const prev = tops([
      ["a", 0],
      ["b", 30],
    ]);
    const next = tops([
      ["a", 0.2],
      ["b", 30.4],
    ]);
    expect(resortOffsets(prev, next).size).toBe(0);
  });

  test("a row that only grew taller still pushes the rows under it", () => {
    // Nothing reordered: b's title wrapped onto a second line.
    const prev = tops([
      ["a", 0],
      ["b", 30],
      ["c", 60],
    ]);
    const next = tops([
      ["a", 0],
      ["b", 30],
      ["c", 78],
    ]);

    const offsets = resortOffsets(prev, next);
    expect(offsets.has("a")).toBe(false);
    expect(offsets.has("b")).toBe(false);
    expect(offsets.get("c")).toBe(-18);
  });
});
