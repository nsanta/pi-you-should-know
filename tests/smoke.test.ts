import { describe, expect, it } from "vitest";
import factory from "../src/index.ts";

describe("bootstrap", () => {
  it("exports a factory function", () => {
    expect(typeof factory).toBe("function");
  });
});
