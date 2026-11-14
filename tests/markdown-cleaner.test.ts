import { describe, expect, it } from "vitest";
import {
  chunkTextForSpeech,
  cleanMarkdownForSpeech,
  hashContent,
} from "../src/markdown-cleaner";

describe("cleanMarkdownForSpeech", () => {
  it("strips frontmatter, wikilinks, markdown links, and formatting", () => {
    const md = `---
title: My Note
tags: [a, b]
---

# Welcome Heading

Here is **bold**, *italic*, \`inline code\`, [[TargetPage|Custom Alias]], and [[PlainPage]].
Check [the docs](https://example.com) and ![[diagram.png]].`;

    const cleaned = cleanMarkdownForSpeech(md);
    expect(cleaned).not.toContain("tags:");
    expect(cleaned).toContain("Welcome Heading.");
    expect(cleaned).toContain("Here is bold, italic, inline code, Custom Alias, and PlainPage.");
    expect(cleaned).toContain("Check the docs and .");
    expect(cleaned).not.toContain("https://example.com");
  });

  it("omits code blocks when skipCodeBlocks is true", () => {
    const md = "Before.\n\n```ts\nconst x = 1;\n```\n\nAfter.";
    const cleaned = cleanMarkdownForSpeech(md, { skipCodeBlocks: true });
    expect(cleaned).toContain("Code block omitted.");
    expect(cleaned).not.toContain("const x = 1");
  });

  it("converts markdown tables and callouts into spoken sentences", () => {
    const md = `> [!tip] Fast Mode
> Use flash models.

| Model | Speed |
| --- | --- |
| Flash | Fast |`;

    const cleaned = cleanMarkdownForSpeech(md);
    expect(cleaned).toContain("tip: Fast Mode.");
    expect(cleaned).toContain("Use flash models.");
    expect(cleaned).toContain("Model, Speed.");
    expect(cleaned).toContain("Flash, Fast.");
  });
});

describe("chunkTextForSpeech", () => {
  it("splits paragraphs and long sentences under maxChars", () => {
    const text =
      "First short paragraph.\n\n" +
      "Sentence one is here. Sentence two is here. Sentence three is here.";
    const chunks = chunkTextForSpeech(text, 45);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(45);
    }
  });

  it("returns empty array for whitespace", () => {
    expect(chunkTextForSpeech("   \n\n  ")).toEqual([]);
  });
});

describe("hashContent", () => {
  it("produces deterministic 8-char hex hashes", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world");
    const h3 = hashContent("hello world!");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
  });
});
