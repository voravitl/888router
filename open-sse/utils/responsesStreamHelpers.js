// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "failed";
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes() {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure()}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure() {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}

// Encoded message_delta + message_stop payload for aborted Claude-format streams.
// Without a terminal event Claude Code hangs forever on "empty or malformed
// response" when an upstream (e.g. Kiro, opencode) aborts mid-stream after
// already returning HTTP 200 + partial SSE. Closing with message_stop lets
// the client treat the stream as ended instead of waiting indefinitely.
export function buildAbortedClaudeTerminalBytes(openBlockIndices = null) {
  // Close any content blocks that are still open (e.g. thinking, text) before
  // emitting message_delta + message_stop. Without this, Claude Code sees
  // message_stop while blocks are still open → "Content block not found".
  let closeBlockEvents = '';
  if (openBlockIndices && openBlockIndices.size > 0) {
    // Close in ascending index order (matches typical open order; some Claude
    // clients expect monotonic closes — closing 0,1,2 rather than Set
    // insertion order which can be 1,0).
    for (const index of [...openBlockIndices].sort((a, b) => a - b)) {
      closeBlockEvents += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`;
    }
  }
  return sharedEncoder.encode(
    closeBlockEvents +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 0, output_tokens: 0 } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  );
}
