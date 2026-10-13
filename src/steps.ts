/**
 * Step counter for the you-should-know review cadence.
 *
 * One step = one completed tool execution (`tool_execution_end`). The caller
 * records steps, asks whether a review is due, and explicitly marks the
 * counter as reviewed when a review actually fires.
 */

/**
 * Tracks completed tool steps since the last background review.
 * The consumed state (step count) is plain and testable; no clocks, no I/O.
 */
export class StepCounter {
  private count = 0;

  /** Record one completed tool execution. */
  recordStep(): void {
    this.count += 1;
  }

  /** Steps recorded since the last markReviewed(). */
  get steps(): number {
    return this.count;
  }

  /**
   * True when the step count has reached the review threshold. The threshold
   * must be a finite number >= 1 (it is floored); anything else never
   * triggers a review, so a broken config fails quiet instead of hot.
   */
  shouldReview(reviewEvery: number): boolean {
    if (typeof reviewEvery !== "number" || !Number.isFinite(reviewEvery) || reviewEvery < 1) return false;
    return this.count >= Math.floor(reviewEvery);
  }

  /** Reset the count after a review has actually been fired. */
  markReviewed(): void {
    this.count = 0;
  }
}
