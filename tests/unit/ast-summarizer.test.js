import { describe, it, expect } from "vitest";
import { summarizeCodeTextToAST } from "../../open-sse/translator/concerns/astSummarizer.js";
import { pruneMessageHistory } from "../../open-sse/translator/concerns/pruner.js";

describe("P2: Dynamic AST Soft-Pruner & History Shrinker (Hardened)", () => {
  it("condenses JS/TS code blocks to AST outlines while preserving signatures", () => {
    const jsCode = `\`\`\`ts
import fs from "fs";

export async function processData(items: number[]) {
  const result = [];
  for (const item of items) {
    result.push(item * 2);
  }
  return result;
}

export class DataProcessor {
  constructor() {
    this.name = "processor";
  }
  public async handle(input: string): Promise<boolean> {
    console.log("doing work line 1");
    console.log("doing work line 2");
    console.log("doing work line 3");
    console.log("doing work line 4");
    console.log("doing work line 5");
    console.log("doing work line 6");
    console.log("doing work line 7");
    console.log("doing work line 8");
    return true;
  }
}
\`\`\``;

    const summarized = summarizeCodeTextToAST(jsCode);
    expect(summarized.length).toBeLessThan(jsCode.length);
    expect(summarized).toContain("export async function processData");
    expect(summarized).toContain("export class DataProcessor");
    expect(summarized).toContain("public async handle");
    expect(summarized).toContain("condensed to AST outline by 888router");
  });

  it("extracts Python, Go, and Rust AST outlines correctly", () => {
    const pyCode = `\`\`\`python
import os
import sys

class PythonWorker:
    def __init__(self):
        self.active = True

    async def execute_task(self, data):
        print("heavy computation line 1")
        print("heavy computation line 2")
        print("heavy computation line 3")
        print("heavy computation line 4")
        print("heavy computation line 5")
        print("heavy computation line 6")
        print("heavy computation line 7")
        print("heavy computation line 8")
        print("heavy computation line 9")
        print("heavy computation line 10")
        print("heavy computation line 11")
        return True
\`\`\``;

    const summarizedPy = summarizeCodeTextToAST(pyCode);
    expect(summarizedPy.length).toBeLessThan(pyCode.length);
    expect(summarizedPy).toContain("class PythonWorker");
    expect(summarizedPy).toContain("async def execute_task");

    const goCode = `\`\`\`go
package main

import "fmt"

type ServiceConfig struct {
	Port int
	Host string
}

func ProcessRequest(req string) (string, error) {
	fmt.Println("line 1")
	fmt.Println("line 2")
	fmt.Println("line 3")
	fmt.Println("line 4")
	fmt.Println("line 5")
	fmt.Println("line 6")
	fmt.Println("line 7")
	fmt.Println("line 8")
	fmt.Println("line 9")
	fmt.Println("line 10")
	return req, nil
}
\`\`\``;

    const summarizedGo = summarizeCodeTextToAST(goCode);
    expect(summarizedGo.length).toBeLessThan(goCode.length);
    expect(summarizedGo).toContain("type ServiceConfig struct");
    expect(summarizedGo).toContain("func ProcessRequest");
  });

  it("strictly enforces zero-bloat invariant on one-liner function dumps", () => {
    const denseOneLiners = "```js\n" + Array.from({ length: 500 }, (_, i) => `function fn${i}() { return ${i}; }`).join("\n") + "\n```";
    const summarized = summarizeCodeTextToAST(denseOneLiners);
    expect(summarized.length).toBeLessThan(denseOneLiners.length); // Never bloats
  });

  it("saves middle turns via soft-only path (astSummarized: true, pruned: false)", () => {
    const codeBody = "```js\n" + Array.from({ length: 8000 }, (_, i) => `// comment line ${i}\nfunction doWork${i}() {\n  console.log('doing work line ' + ${i});\n  return ${i};\n}`).join("\n") + "\n```";
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "initial system & skill prompt" },
        { role: "assistant", content: "understood" },
        { role: "user", content: "middle prompt with code" },
        { role: "assistant", content: codeBody },
        { role: "user", content: "latest user prompt" }
      ]
    };

    // Prune history — soft AST summarization brings tokens below budget so NO middle turns are dropped
    const prunedBody = pruneMessageHistory(body, "openai", "gpt-4o-mini");
    expect(prunedBody._prunerStats).toBeDefined();
    expect(prunedBody._prunerStats.astSummarized).toBe(true);
    expect(prunedBody._prunerStats.omittedMessages).toBe(0); // Soft path saved middle turn from hard drop!
    expect(prunedBody.messages.length).toBe(6); // All 6 messages intact!
  });

  it("handles Gemini parts array format in soft AST summarizer", () => {
    const hugeCode = "```js\n" + Array.from({ length: 300 }, (_, i) => `function fn${i}() {\n  console.log(${i});\n}`).join("\n") + "\n```";
    const body = {
      contents: [
        { role: "user", parts: [{ text: "start" }] },
        { role: "model", parts: [{ text: hugeCode }] },
        { role: "user", parts: [{ text: "continue" }] }
      ]
    };

    const prunedBody = pruneMessageHistory(body, "gemini", "gemini-1.5-pro");
    expect(prunedBody._prunerStats).toBeDefined();
  });
});
