export interface CleanOptions {
  skipCodeBlocks?: boolean;
}

/**
 * Deterministic Markdown-to-Speech preprocessor.
 * Strips frontmatter, links, formatting, tables, and optional code blocks
 * so text sounds natural when spoken directly or as an offline fallback.
 */
export function cleanMarkdownForSpeech(
  markdown: string,
  options: CleanOptions = {}
): string {
  const skipCodeBlocks = options.skipCodeBlocks ?? true;
  let text = markdown.replace(/\r\n/g, "\n");

  // 1. Strip YAML frontmatter at start of document
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, "");

  // 2. Handle fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, (block) => {
    if (skipCodeBlocks) {
      return "\nCode block omitted.\n";
    }
    const inner = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
    return `\n${inner}\n`;
  });

  // 3. Remove HTML comments and tags
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<[^>]+>/g, " ");

  // 4. Embedded images/files: ![[img.png]] or ![alt](url)
  text = text.replace(/!\[\[([^\]]+)\]\]/g, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt: string) =>
    alt.trim() ? `Image: ${alt.trim()}.` : ""
  );

  // 5. Wikilinks: [[target|alias]] -> alias, [[target]] -> target
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

  // 6. Standard markdown links: [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // 7. Footnote refs [^1] and definitions
  text = text.replace(/\[\^[^\]]+\]:.*$/gm, "");
  text = text.replace(/\[\^[^\]]+\]/g, "");

  // 8. Callout headers: > [!note] Title -> Note: Title
  text = text.replace(/^>\s*\[!([^\]]+)\]\s*(.*)$/gm, (_, kind: string, title: string) => {
    const cleanKind = kind.trim();
    return title.trim() ? `${cleanKind}: ${title.trim()}.` : `${cleanKind}.`;
  });

  // 9. Blockquotes and headings
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1.");

  // 10. Horizontal rules and table separator rows
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");
  text = text.replace(/^\|?[\s:-]+\|[\s|:-]*$/gm, "");

  // 11. Table rows: | A | B | -> A, B.
  text = text.replace(/^\|(.+)\|\s*$/gm, (_, row: string) => {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    return cells.length > 0 ? `${cells.join(", ")}.` : "";
  });

  // 12. Task list markers & bullet markers
  text = text.replace(/^\s*[-*+]\s+\[[xX ]\]\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");

  // 13. Inline formatting: bold, italic, strikethrough, highlight, inline code
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/(\*\*\*|___)(.*?)\1/g, "$2");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/==(.*?)==/g, "$1");

  // 14. Collapse excessive whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Splits clean spoken text into natural chunks (under maxChars)
 * at paragraph and sentence boundaries for responsive playback and skip/pause.
 */
export function chunkTextForSpeech(text: string, maxChars = 420): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, " ").trim())
    .filter(Boolean);

  const chunks: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      chunks.push(para);
      continue;
    }

    // Split long paragraph on sentence boundaries
    const sentences = para.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [para];
    let current = "";

    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;

      if (current && current.length + 1 + sentence.length > maxChars) {
        chunks.push(current);
        current = sentence;
      } else if (!current && sentence.length > maxChars) {
        // Hard-split oversized sentence on word boundaries
        const words = sentence.split(/\s+/);
        let part = "";
        for (const w of words) {
          if (part && part.length + 1 + w.length > maxChars) {
            chunks.push(part);
            part = w;
          } else {
            part = part ? `${part} ${w}` : w;
          }
        }
        if (part) current = part;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }

    if (current) {
      chunks.push(current);
    }
  }

  return chunks;
}

/**
 * Fast FNV-1a 32-bit hash for listenable script cache keys.
 */
export function hashContent(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
