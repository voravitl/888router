// JSON Auto-Repair Engine (Layer 4)
// Robustly repairs malformed JSON emitted by non-tool-tuned open models.

/**
 * Attempts to parse JSON string with automatic repairs for common LLM syntax errors.
 * Returns parsed object or null if irreparable (Fail-Open safety).
 */
export function repairAndParseJson(rawStr) {
  if (!rawStr || typeof rawStr !== "string") return null;
  const trimmed = rawStr.trim();

  // Try standard JSON.parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Proceed to auto-repair
  }

  try {
    let repaired = trimmed;

    // Fix 1: Remove trailing commas in objects & arrays (e.g. `{"a": 1,}` or `[1, 2,]`)
    repaired = repaired.replace(/,(\s*[\}\]])/g, "$1");

    // Fix 2: Replace single quotes around keys/values with double quotes if not escaped
    // e.g. {'name': 'run_command'} -> {"name": "run_command"}
    repaired = repaired.replace(/(['"])?([a-zA-Z0-9_]+)\1\s*:\s*/g, '"$2":');

    // Fix 3: Handle single-quoted values e.g. : 'value' -> : "value"
    repaired = repaired.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ':"$1"');

    // Try parsing repaired string
    return JSON.parse(repaired);
  } catch {
    // Fail-open: return null so caller knows JSON could not be parsed safely
    return null;
  }
}
