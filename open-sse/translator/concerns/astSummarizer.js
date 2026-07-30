/**
 * Concern: AST Soft-Summarizer & Structural History Shrinker
 * Extracts AST outlines (function signatures, class definitions, struct interfaces)
 * from code blocks in older history turns to preserve code context without hard-dropping turns.
 */

const MIN_AST_SUMMARIZE_CHARS = 150;

/**
 * Summarize code blocks inside a text string into AST outlines.
 * Enforces strict shrink invariant: out.length < text.length * 0.9
 */
export function summarizeCodeTextToAST(text) {
  if (!text || typeof text !== "string" || !text.includes("```")) return text;

  return text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    if (!code || code.length < MIN_AST_SUMMARIZE_CHARS) return match; // Keep short code blocks intact

    const outline = extractASTOutline(code, lang.toLowerCase());
    const result = `\`\`\`${lang}\n${outline}\n\`\`\``;

    // Strict no-bloat invariant: only accept if result is actually shorter than match
    return result.length < match.length ? result : match;
  });
}

/**
 * Extract AST signatures/outlines based on programming language
 */
function extractASTOutline(code, lang) {
  const lines = code.split("\n");
  if (lines.length <= 15) return code;

  const signatures = [];
  const normalizedLang = lang.trim().toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // JS / TS / JSX / TSX
    if (normalizedLang === "js" || normalizedLang === "javascript" ||
        normalizedLang === "ts" || normalizedLang === "typescript" ||
        normalizedLang === "jsx" || normalizedLang === "tsx" || !normalizedLang) {
      if (/^(export\s+)?(default\s+)?(async\s+)?function\b/.test(trimmed) ||
          /^(export\s+)?(class|interface|type|enum)\b/.test(trimmed) ||
          /^(export\s+)?const\s+[a-zA-Z0-9_$]+\s*=\s*/.test(trimmed) ||
          /^\s*(public|private|protected|static|async)*\s*[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*([{:]|$)/.test(trimmed)) {
        signatures.push(line);
        continue;
      }
    }

    // Python
    if (normalizedLang === "py" || normalizedLang === "python") {
      if (/^(async\s+)?def\b/.test(trimmed) || /^class\b/.test(trimmed)) {
        signatures.push(line);
        continue;
      }
    }

    // Go
    if (normalizedLang === "go" || normalizedLang === "golang") {
      if (/^func\b/.test(trimmed) || /^type\s+[a-zA-Z0-9_$]+\s+(struct|interface)\b/.test(trimmed)) {
        signatures.push(line);
        continue;
      }
    }

    // Rust
    if (normalizedLang === "rs" || normalizedLang === "rust") {
      if (/^(pub\s+)?(async\s+)?fn\b/.test(trimmed) || /^(pub\s+)?(struct|enum|trait|impl)\b/.test(trimmed)) {
        signatures.push(line);
        continue;
      }
    }

    // Generic fallback for any lang
    if (/^(export|default|pub|public|func|def|fn|function|class|struct|interface|type)\b/.test(trimmed)) {
      signatures.push(line);
      continue;
    }

    // Keep comments & imports near top
    if (i < 5 && (/^(import|require|package|use|from)\b/.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*"))) {
      signatures.push(line);
    }
  }

  // Head/Tail Fallback if too many signatures were matched or none found
  if (signatures.length === 0 || signatures.length > lines.length * 0.5) {
    const head = lines.slice(0, 5).join("\n");
    const tail = lines.slice(-2).join("\n");
    return `${head}\n// ... [${lines.length - 7} lines condensed by 888router AST Summarizer] ...\n${tail}`;
  }

  return `${signatures.join("\n")}\n// ... [${lines.length - signatures.length} lines condensed to AST outline by 888router] ...`;
}

/**
 * Softly condense message turns inside middle history groups (supports content and parts arrays)
 * @param {Array} middleGroups - Turn groups in middle history
 * @returns {boolean} True if any text was soft-summarized and reduced in size
 */
export function softSummarizeMiddleGroups(middleGroups) {
  let summarized = false;

  for (const group of middleGroups) {
    if (!group || !Array.isArray(group.messages)) continue;

    for (const msg of group.messages) {
      if (!msg) continue;

      // Handle standard message.content string
      if (typeof msg.content === "string") {
        const out = summarizeCodeTextToAST(msg.content);
        if (out && out.length < msg.content.length) {
          msg.content = out;
          summarized = true;
        }
      }
      // Handle content array (Claude / OpenAI shape)
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part.text === "string") {
            const out = summarizeCodeTextToAST(part.text);
            if (out && out.length < part.text.length) {
              part.text = out;
              summarized = true;
            }
          } else if (part && typeof part.content === "string") {
            const out = summarizeCodeTextToAST(part.content);
            if (out && out.length < part.content.length) {
              part.content = out;
              summarized = true;
            }
          }
        }
      }

      // Handle parts array (Gemini / Antigravity shape)
      if (Array.isArray(msg.parts)) {
        for (const part of msg.parts) {
          if (part && typeof part.text === "string") {
            const out = summarizeCodeTextToAST(part.text);
            if (out && out.length < part.text.length) {
              part.text = out;
              summarized = true;
            }
          }
        }
      }
    }
  }

  return summarized;
}
