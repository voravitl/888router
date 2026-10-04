// Shared finalization for JSON and assembled Chat Completions SSE replies.
export function openAICompletionToResponses(parsed, usage = parsed.usage || {}) {
  const choice = parsed.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const incompleteReason = choice.finish_reason === "length" ? "max_output_tokens"
    : (choice.finish_reason === "content_filter" ? "content_filter" : null);
  const itemStatus = incompleteReason ? "incomplete" : "completed";
  const responseId = String(parsed.id || `resp_${Date.now()}`).replace(/^chatcmpl-/, "resp_");
  if (message.reasoning_content) {
    output.push({ id: `rs_${responseId}`, type: "reasoning", summary: [{ type: "summary_text", text: message.reasoning_content }] });
  }
  if (message.content) {
    output.push({ id: `msg_${responseId}`, type: "message", role: "assistant", status: itemStatus,
      content: [{ type: "output_text", text: message.content, annotations: [] }] });
  }
  for (const [index, call] of (message.tool_calls || []).entries()) {
    const callId = call.id || `call_${responseId}_${index}`;
    output.push({ id: `fc_${callId}`, type: "function_call", call_id: callId,
      name: call.function?.name || "", arguments: call.function?.arguments || "{}", status: itemStatus });
  }
  return {
    id: responseId, object: "response", created_at: parsed.created, model: parsed.model,
    status: incompleteReason ? "incomplete" : "completed", output, error: null,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    usage: {
      input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      ...(usage.prompt_tokens_details && { input_tokens_details: structuredClone(usage.prompt_tokens_details) }),
      ...(usage.completion_tokens_details && { output_tokens_details: structuredClone(usage.completion_tokens_details) }),
      ...(usage.estimated !== undefined && { estimated: usage.estimated }),
    },
  };
}
