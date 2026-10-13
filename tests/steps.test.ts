import { describe, expect, it } from "vitest";
import { StepCounter } from "../src/steps.ts";

describe("StepCounter", () => {
  it("starts at zero and does not review", () => {
    const counter = new StepCounter();
    expect(counter.steps).toBe(0);
    expect(counter.shouldReview(6)).toBe(false);
  });

  it("recommends a review only once the threshold is reached", () => {
    const counter = new StepCounter();
    for (let i = 0; i < 5; i += 1) {
      counter.recordStep();
      expect(counter.shouldReview(6)).toBe(false);
    }
    counter.recordStep();
    expect(counter.shouldReview(6)).toBe(true);
  });

  it("markReviewed resets the count", () => {
    const counter = new StepCounter();
    for (let i = 0; i < 6; i += 1) counter.recordStep();
    expect(counter.shouldReview(6)).toBe(true);
    counter.markReviewed();
    expect(counter.steps).toBe(0);
    expect(counter.shouldReview(6)).toBe(false);
    counter.recordStep();
    expect(counter.shouldReview(6)).toBe(false);
  });

  it("supports thresholds of 1", () => {
    const counter = new StepCounter();
    expect(counter.shouldReview(1)).toBe(false);
    counter.recordStep();
    expect(counter.shouldReview(1)).toBe(true);
  });

  it("never reviews with invalid thresholds", () => {
    const counter = new StepCounter();
    counter.recordStep();
    expect(counter.shouldReview(0)).toBe(false);
    expect(counter.shouldReview(-3)).toBe(false);
    expect(counter.shouldReview(Number.NaN)).toBe(false);
    expect(counter.shouldReview(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
