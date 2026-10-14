import { describe, expect, it } from "vitest";
import factory from "../src/index.ts";
import { parseYskArgs } from "../src/actions.ts";
import { deriveTopic } from "../src/tool.ts";
import { popupListRows } from "../src/widget.ts";

describe("bootstrap", () => {
  it("exports a factory function and the T4/T5 module surfaces load cleanly", () => {
    expect(typeof factory).toBe("function");
    expect(typeof parseYskArgs).toBe("function");
    expect(popupListRows([])).toEqual([]);
    expect(deriveTopic("Some Note")).toBe("some note");
  });
});
