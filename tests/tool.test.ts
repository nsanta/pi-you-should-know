import { describe, expect, it, vi } from "vitest";
import { deriveTitle, deriveTopic, registerHeadsUpTool, TOPIC_MAX_CHARS } from "../src/tool.ts";
import { NoteStore } from "../src/notes.ts";

describe("deriveTopic", () => {
  it("uses the first line, collapsed and lowercased", () => {
    expect(deriveTopic("  Deployment   gate\nis manual  ")).toBe("deployment gate");
  });

  it("caps the topic length for stable identity", () => {
    expect(deriveTopic(`${"x".repeat(200)} tail`).length).toBeLessThanOrEqual(TOPIC_MAX_CHARS);
  });

  it("returns empty for empty or non-string input", () => {
    expect(deriveTopic("")).toBe("");
    expect(deriveTopic("   \n  ")).toBe("");
    expect(deriveTopic(undefined as never)).toBe("");
  });
});

describe("deriveTitle", () => {
  it("is the collapsed first line without the topic cap", () => {
    expect(deriveTitle("Deployment gate\nis manual")).toBe("Deployment gate");
    expect(deriveTitle("y".repeat(200)).length).toBeGreaterThan(TOPIC_MAX_CHARS);
  });
});

describe("registerHeadsUpTool", () => {
  type Execute = (id: string, params: unknown, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<any>;

  function setup() {
    const tools = new Map<string, { name: string; label: string; description: string; parameters: unknown; execute: Execute }>();
    const pi = { registerTool: (tool: never) => tools.set((tool as { name: string }).name, tool as never) };
    const store = new NoteStore();
    registerHeadsUpTool(pi as never, store);
    return { tool: tools.get("heads_up")!, store };
  }

  const firstText = (result: any): string => result.content[0].text;

  it("registers the heads_up tool with a minimal TypeBox schema", () => {
    const { tool } = setup();
    expect(tool.name).toBe("heads_up");
    expect(tool.label).toBeTypeOf("string");
    expect(tool.description).toBeTypeOf("string");
    const schema = tool.parameters as { properties: Record<string, any> };
    expect(schema.properties.note).toBeDefined();
    expect(schema.properties.note.minLength).toBe(1);
    expect(schema.properties.severity.default).toBe("info");
  });

  it("records a note through the shared NoteStore pipeline", async () => {
    const { tool, store } = setup();
    const result = await tool.execute("id", { note: "Deployment gate is manual", severity: "warning" });
    expect(firstText(result)).toContain("Recorded");
    expect(result.details).toMatchObject({ topic: "deployment gate is manual", severity: "warning", added: true });
    expect(store.pending).toHaveLength(1);
    expect(store.pending[0]!.title).toBe("Deployment gate is manual");
  });

  it("defaults severity to info", async () => {
    const { tool } = setup();
    const result = await tool.execute("id", { note: "Something to know" });
    expect(result.details.severity).toBe("info");
  });

  it("reports duplicates as success without re-adding", async () => {
    const { tool, store } = setup();
    await tool.execute("id", { note: "Same topic\nbody one" });
    const result = await tool.execute("id", { note: "Same topic\nbody two, phrased again" });
    expect(result.details.added).toBe(false);
    expect(firstText(result)).toContain("already");
    expect(store.pending).toHaveLength(1);
  });

  it("returns an isError result for an empty note instead of throwing", async () => {
    const { tool, store } = setup();
    const result = await tool.execute("id", { note: "   " });
    expect(result.isError).toBe(true);
    expect(store.pending).toHaveLength(0);
  });

  it("never throws, even on garbage input or a throwing store", async () => {
    const tools = new Map<string, { execute: Execute }>();
    const pi = { registerTool: (tool: never) => tools.set((tool as { name: string }).name, tool as never) };
    const hostile = { add: () => { throw new Error("boom"); } } as never as NoteStore;
    registerHeadsUpTool(pi as never, hostile);
    const result = await tools.get("heads_up")!.execute("id", { note: "anything" });
    expect(result.isError).toBe(true);

    const { tool } = setup();
    const garbage = await tool.execute("id", null);
    expect(garbage.isError).toBe(true);
  });
});
