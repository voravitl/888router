import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { softSummarizeMiddleGroups } from "./astSummarizer.js";

const DEFAULT_RESERVE_TOKENS = 4000;
const CHARS_PER_TOKEN = 3.5;
const FIXED_IMAGE_TOKENS = 1000;

/**
 * Estimate token count for request body (supports OpenAI, Claude, and Gemini shapes)
 */
export function estimateRequestTokens(body) {
  if (!body) return 0;
  let textLength = 0;
  let mediaCount = 0;

  const processContent = (content) => {
    if (typeof content === "string") {
      textLength += content.length;
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item) continue;
        if (typeof item === "string") {
          textLength += item.length;
        } else if (typeof item === "object") {
          if (typeof item.text === "string") textLength += item.text.length;
          if (typeof item.content === "string") textLength += item.content.length;
          else if (Array.isArray(item.content)) processContent(item.content);
          if (typeof item.output === "string") textLength += item.output.length;

          if (item.type === "image_url" || item.type === "image" || item.type === "input_image") mediaCount++;
          if (item.inlineData || item.fileData) mediaCount++;
        }
      }
    }
  };

  const messages = body.messages || body.input || body.contents || body.request?.contents || [];
  for (const msg of messages) {
    if (!msg) continue;
    const role = msg.role || (msg.author ? String(msg.author) : "");
    if (role === "system" && typeof msg.content === "string") textLength += msg.content.length;
    else processContent(msg.content || msg.parts);
    if (msg.reasoning_content) textLength += msg.reasoning_content.length;
    if (Array.isArray(msg.tool_calls)) textLength += JSON.stringify(msg.tool_calls).length;
  }

  if (Array.isArray(body.tools)) {
    textLength += JSON.stringify(body.tools).length;
  }

  const estimated = Math.ceil(textLength / CHARS_PER_TOKEN) + (mediaCount * FIXED_IMAGE_TOKENS);
  return estimated;
}

/**
  * Resolve target object and array key for messages in request body
  */
function getMessagesTarget(body) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.messages)) return { target: body, key: "messages" };
  if (Array.isArray(body.input)) return { target: body, key: "input" };
  if (Array.isArray(body.contents)) return { target: body, key: "contents" };
  if (Array.isArray(body.request?.contents)) return { target: body.request, key: "contents" };
  return null;
}

/**
 * Group messages into atomic turn groups to ensure tool_use & tool_result pairs are never split.
 * Handles both OpenAI (role: "tool") and Claude (role: "user" with type: "tool_result") shapes.
 */
export function groupMessageTurns(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const groups = [];
  let currentGroup = [];

  const isToolResultMsg = (msg) => {
    if (!msg) return false;
    if (msg.role === "tool" || msg.role === "function") return true;
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return msg.content.some(b => b && (b.type === "tool_result" || b.tool_use_id));
    }
    return false;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === "system") {
      if (currentGroup.length > 0) {
        groups.push({ messages: currentGroup });
        currentGroup = [];
      }
      groups.push({ isSystem: true, messages: [msg] });
      continue;
    }

    if (msg.role === "user" && !isToolResultMsg(msg)) {
      if (currentGroup.length > 0) {
        groups.push({ messages: currentGroup });
        currentGroup = [];
      }
      currentGroup.push(msg);
    } else {
      // assistant or tool or user tool_result
      currentGroup.push(msg);
    }
  }

  if (currentGroup.length > 0) {
    groups.push({ messages: currentGroup });
  }

  if (groups.length > 0) {
    // Mark first non-system group as initial (contains system instructions / skills / workspace context — must be preserved)
    for (let i = 0; i < groups.length; i++) {
      if (!groups[i].isSystem) {
        groups[i].isInitial = true;
        break;
      }
    }
    // Mark last non-system group as trailing (must be preserved)
    for (let j = groups.length - 1; j >= 0; j--) {
      if (!groups[j].isSystem && !groups[j].isInitial) {
        groups[j].isTrailing = true;
        break;
      }
    }
  }

  return groups;
}

/**
 * Prune message history atomically while preserving tool pairs, system prompt, and trailing user turn.
 * First applies Soft AST Compression to middle code blocks; falls back to hard middle-out drop if still over budget.
 */
export function pruneMessageHistory(body, provider, model) {
  if (!body || typeof body !== "object") return body;
  const targetInfo = getMessagesTarget(body);
  if (!targetInfo) return body;

  const caps = getCapabilitiesForModel(provider, model);
  const contextWindow = caps.contextWindow || 200000;
  const maxOutput = caps.maxOutput || 64000;

  // Safe budget formula: never collapse below 70% of contextWindow even when maxOutput equals contextWindow
  const rawBudget = contextWindow - maxOutput - DEFAULT_RESERVE_TOKENS;
  const budget = Math.max(Math.floor(contextWindow * 0.7), rawBudget);

  const initialEstimate = estimateRequestTokens(body);
  body._prunerStats = {
    tokensBefore: initialEstimate,
    tokensAfter: initialEstimate,
    tokensSaved: 0,
    omittedMessages: 0,
    astSummarized: false,
    pruned: false
  };

  if (initialEstimate <= budget) return body;

  const originalMessages = targetInfo.target[targetInfo.key];
  const groups = groupMessageTurns(originalMessages);

  const systemGroups = groups.filter(g => g.isSystem);
  const initialGroups = groups.filter(g => g.isInitial);
  const trailingGroups = groups.filter(g => g.isTrailing);
  const middleGroups = groups.filter(g => !g.isSystem && !g.isInitial && !g.isTrailing);

  if (middleGroups.length === 0) return body;

  // Phase 1: Soft AST Summarization of code blocks in middle turns
  const astSummarized = softSummarizeMiddleGroups(middleGroups);
  if (astSummarized) {
    body._prunerStats.astSummarized = true;
  }

  const softCandidateBody = {
    ...body
  };

  const softMessages = [
    ...systemGroups.flatMap(g => g.messages),
    ...initialGroups.flatMap(g => g.messages),
    ...middleGroups.flatMap(g => g.messages),
    ...trailingGroups.flatMap(g => g.messages)
  ];
  if (targetInfo.target === body) {
    softCandidateBody[targetInfo.key] = softMessages;
  } else {
    softCandidateBody.request = { ...body.request, [targetInfo.key]: softMessages };
  }

  if (estimateRequestTokens(softCandidateBody) <= budget) {
    targetInfo.target[targetInfo.key] = softMessages;
    const tokensAfter = estimateRequestTokens(body);
    body._prunerStats.tokensAfter = tokensAfter;
    body._prunerStats.tokensSaved = Math.max(0, initialEstimate - tokensAfter);
    return body;
  }

  // Phase 2: Hard middle-out drop if tokens still exceed budget
  // Prefer dropping text-only groups before tool-bearing groups to preserve
  // tool call history. Tool groups are dropped only as last resort.
  // IMPORTANT: preserve original chronological order — never reorder groups.
  let prunedMiddle = [...middleGroups];
  let omittedCount = 0;

  // Detect if a group contains tool calls/results (must keep preferentially)
  const hasToolContent = (group) =>
    group.messages.some((msg) => {
      if (msg.role === "tool" || msg.role === "function") return true;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
      if (msg.role === "user" && Array.isArray(msg.content)) {
        return msg.content.some((b) => b && (b.type === "tool_result" || b.tool_use_id));
      }
      // Claude format: assistant messages with tool_use blocks
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return msg.content.some((b) => b && b.type === "tool_use");
      }
      return false;
    });

  // Tag each group once: true = tool-bearing, false = text-only
  const toolFlags = prunedMiddle.map(hasToolContent);

  // Drop groups oldest-first until remaining fit in budget.
  // Pass 1: drop text-only groups first (preserve tool history).
  // Pass 2: if still over budget, drop tool groups too.
  for (let pass = 0; pass < 2; pass++) {
    let i = 0;
    while (i < prunedMiddle.length) {
      const isTool = toolFlags[i];
      if ((pass === 0 && isTool) || (pass === 1 && !isTool)) { i++; continue; }
      // Drop this group permanently
      const removedMsgs = prunedMiddle[i]?.messages?.length || 1;
      prunedMiddle.splice(i, 1);
      toolFlags.splice(i, 1);
      omittedCount += removedMsgs;
      // Check if remaining fit in budget
      const candidateBody = { ...body };
      const candidateMsgs = [
        ...systemGroups.flatMap((g) => g.messages),
        ...initialGroups.flatMap((g) => g.messages),
        ...prunedMiddle.flatMap((g) => g.messages),
        ...trailingGroups.flatMap((g) => g.messages),
      ];
      if (targetInfo.target === body) {
        candidateBody[targetInfo.key] = candidateMsgs;
      } else {
        candidateBody.request = { ...body.request, [targetInfo.key]: candidateMsgs };
      }

      if (estimateRequestTokens(candidateBody) <= budget) {
        i = prunedMiddle.length; // exit while
        break;
      }
      // i stays same (next group shifted in)
    }
    // Check if already under budget after pass 1
    if (pass === 0) {
      const checkBody = { ...body };
      const checkMsgs = [
        ...systemGroups.flatMap((g) => g.messages),
        ...initialGroups.flatMap((g) => g.messages),
        ...prunedMiddle.flatMap((g) => g.messages),
        ...trailingGroups.flatMap((g) => g.messages),
      ];
      if (targetInfo.target === body) {
        checkBody[targetInfo.key] = checkMsgs;
      } else {
        checkBody.request = { ...body.request, [targetInfo.key]: checkMsgs };
      }
      if (estimateRequestTokens(checkBody) <= budget) break;
    }
  }

  const tombstoneText = `[earlier ${omittedCount || 1} history turns omitted for context limit]`;
  const remainingMiddleAndTrailing = [
    ...prunedMiddle.flatMap((g) => g.messages),
    ...trailingGroups.flatMap((g) => g.messages),
  ];

  let finalMessages = [];
  const leadingMsgs = [
    ...systemGroups.flatMap((g) => g.messages),
    ...initialGroups.flatMap((g) => g.messages),
  ];

  if (omittedCount > 0) {
    if (remainingMiddleAndTrailing.length > 0 && remainingMiddleAndTrailing[0].role === "user") {
      // Avoid consecutive user messages: merge tombstone text directly into the first user message
      const firstMsg = { ...remainingMiddleAndTrailing[0] };
      if (typeof firstMsg.content === "string") {
        firstMsg.content = `${tombstoneText}\n\n${firstMsg.content}`;
      } else if (Array.isArray(firstMsg.content)) {
        firstMsg.content = [{ type: "text", text: `${tombstoneText}\n\n` }, ...firstMsg.content];
      } else if (Array.isArray(firstMsg.parts)) {
        const partsCopy = [...firstMsg.parts];
        if (partsCopy.length > 0 && typeof partsCopy[0].text === "string") {
          partsCopy[0] = { ...partsCopy[0], text: `${tombstoneText}\n\n${partsCopy[0].text}` };
        } else {
          partsCopy.unshift({ text: `${tombstoneText}\n\n` });
        }
        firstMsg.parts = partsCopy;
      } else {
        firstMsg.content = tombstoneText;
      }
      finalMessages = [
        ...leadingMsgs,
        firstMsg,
        ...remainingMiddleAndTrailing.slice(1),
      ];
    } else {
      // First remaining message is assistant or tool (or empty): insert standalone user tombstone
      const standaloneTombstone = targetInfo.key === "contents"
        ? { role: "user", parts: [{ text: tombstoneText }] }
        : { role: "user", content: tombstoneText };
      finalMessages = [
        ...leadingMsgs,
        standaloneTombstone,
        ...remainingMiddleAndTrailing,
      ];
    }
  } else {
    finalMessages = [
      ...leadingMsgs,
      ...remainingMiddleAndTrailing,
    ];
  }

  targetInfo.target[targetInfo.key] = finalMessages;
  const tokensAfter = estimateRequestTokens(body);
  const tokensSaved = Math.max(0, initialEstimate - tokensAfter);
  body._prunerStats = {
    tokensBefore: initialEstimate,
    tokensAfter,
    tokensSaved,
    omittedMessages: omittedCount,
    astSummarized,
    pruned: omittedCount > 0
  };
  if (omittedCount > 0) {
    body._pruned = true;
    body._omittedTurns = omittedCount;
  }
  return body;
}

