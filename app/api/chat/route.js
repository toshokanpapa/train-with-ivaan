import { IVAAN_SYSTEM_PROMPT } from "../../../lib/ivaan-prompt";
import { STREAM_ERROR_MARK } from "../../../lib/errors";

export const runtime = "nodejs";
export const maxDuration = 300; // seconds — matches the Hobby-plan ceiling with Fluid compute enabled

const MODEL = "claude-opus-5-5";
// How much Opus 5.5 thinks before replying (it always thinks; this sets how much).
// "medium" is the model's default, written out so it's visible: low | medium | high | xhigh | max.
const EFFORT = "medium";
const MAX_TURNS = 90; // hard backstop, never mentioned to the user
const MAX_USER_CHARS = 6000; // longer messages are trimmed, not rejected
const MAX_ASSISTANT_CHARS = 20000; // loose guard; real replies are bounded by max_tokens
const MAX_TOKENS = 9000; // ceiling, not a target — leaves room for hidden thinking plus the reply
const CACHE = { type: "ephemeral", ttl: "1h" }; // Anthropic offers 5m or 1h; 1h survives long reflective pauses
const TRIM_NOTE = "\n\n[This message was longer than 6,000 characters. Only the first part is shown.]";

// Anthropic statuses worth one silent retry from the page; everything else won't fix itself.
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

// One line per turn in Vercel's Logs tab (search "ivaan_turn").
// Numbers and labels only — never any conversation text.
function logTurn(fields) {
  console.log("ivaan_turn " + JSON.stringify(fields));
}

function errorResponse(kind, status) {
  return new Response(JSON.stringify({ kind }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req) {
  const startedAt = Date.now();
  let body;
  try {
    body = await req.json();
  } catch {
    logTurn({ status: "bad_request", reason: "unparseable_body" });
    return errorResponse("fatal", 400);
  }

  const incoming = Array.isArray(body?.messages) ? body.messages : null;
  if (!incoming || incoming.length === 0) {
    logTurn({ status: "bad_request", reason: "no_messages" });
    return errorResponse("fatal", 400);
  }

  // Basic shape checks on every message.
  for (const m of incoming) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      logTurn({ status: "bad_request", reason: "bad_message_shape" });
      return errorResponse("fatal", 400);
    }
  }

  // Trim over-long messages instead of rejecting them. Claude is told when a
  // user message was cut, so Ivaan can ask about the rest rather than assume.
  let trimmed = 0;
  const messages = incoming.map((m) => {
    if (m.role === "user" && m.content.length > MAX_USER_CHARS) {
      trimmed++;
      return { role: "user", content: m.content.slice(0, MAX_USER_CHARS) + TRIM_NOTE };
    }
    if (m.role === "assistant" && m.content.length > MAX_ASSISTANT_CHARS) {
      trimmed++;
      return { role: "assistant", content: m.content.slice(0, MAX_ASSISTANT_CHARS) };
    }
    return { role: m.role, content: m.content };
  });

  // Hard cap as a pure cost/abuse backstop — never surfaced to the user.
  if (messages.length > MAX_TURNS) {
    logTurn({ status: "turn_cap", messages: messages.length });
    const closing =
      "All the ocean will ever hear of the frog is its song. We've covered a lot of ground today — I'd rather leave what we found here than stretch it thin. Thank you for the conversation.";
    return new Response(closing, { status: 200 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logTurn({ status: "config_error", reason: "missing_api_key" });
    return errorResponse("fatal", 500);
  }

  // Everything the log line reports, filled in as the stream arrives.
  const turn = {
    status: "ok",
    model: MODEL,
    messages: messages.length,
    trimmed,
    input_tokens: null,
    cache_read: null,
    cache_write: null,
    output_tokens: null,
    thinking_blocks: 0, // silent thinking before (or between) the visible reply
    thinking_ms: null, // from the first thinking block to the first visible word
    text_chars: 0, // length of the visible reply, to compare against output_tokens
    stop_reason: null,
    first_word_ms: null,
    total_ms: null,
    error_type: null,
    anthropic_request_id: null,
  };

  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: EFFORT },
        // Cache the instructions explicitly, and let automatic caching move a second
        // marker to the end of the conversation each turn, so only new text is read fresh.
        system: [{ type: "text", text: IVAAN_SYSTEM_PROMPT, cache_control: CACHE }],
        cache_control: CACHE,
        stream: true,
        messages,
      }),
    });
  } catch {
    logTurn({ ...turn, status: "upstream_error", error_type: "network", total_ms: Date.now() - startedAt });
    return errorResponse("transient", 502);
  }

  turn.anthropic_request_id = anthropicRes.headers.get("request-id");

  if (!anthropicRes.ok || !anthropicRes.body) {
    const errText = await anthropicRes.text().catch(() => "");
    let errorType = "http_" + anthropicRes.status;
    try {
      errorType = JSON.parse(errText)?.error?.type || errorType;
    } catch {
      // Keep the status-based label.
    }
    logTurn({
      ...turn,
      status: "upstream_error",
      error_type: errorType,
      upstream_status: anthropicRes.status,
      total_ms: Date.now() - startedAt,
    });
    return errorResponse(TRANSIENT_STATUSES.has(anthropicRes.status) ? "transient" : "fatal", 502);
  }

  // Parse Anthropic's SSE stream and re-emit just the plain text deltas,
  // so the client can read this as a simple text stream with no SSE parsing of its own.
  // Along the way, keep the usage, stop reason and any error for the log line.
  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let thinkingStartedAt = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;
            let evt;
            try {
              evt = JSON.parse(jsonStr);
            } catch {
              continue; // Ignore malformed lines rather than breaking the stream.
            }

            if (
              evt.type === "content_block_start" &&
              (evt.content_block?.type === "thinking" || evt.content_block?.type === "redacted_thinking")
            ) {
              turn.thinking_blocks++;
              if (thinkingStartedAt === null) thinkingStartedAt = Date.now();
            } else if (evt.type === "message_start") {
              const usage = evt.message?.usage || {};
              turn.input_tokens = usage.input_tokens ?? null;
              turn.cache_read = usage.cache_read_input_tokens ?? 0;
              turn.cache_write = usage.cache_creation_input_tokens ?? 0;
            } else if (
              evt.type === "content_block_delta" &&
              evt.delta?.type === "text_delta" &&
              typeof evt.delta.text === "string"
            ) {
              if (turn.first_word_ms === null) {
                turn.first_word_ms = Date.now() - startedAt;
                if (thinkingStartedAt !== null) turn.thinking_ms = Date.now() - thinkingStartedAt;
              }
              turn.text_chars += evt.delta.text.length;
              controller.enqueue(encoder.encode(evt.delta.text));
            } else if (evt.type === "message_delta") {
              turn.stop_reason = evt.delta?.stop_reason ?? turn.stop_reason;
              turn.output_tokens = evt.usage?.output_tokens ?? turn.output_tokens;
            } else if (evt.type === "error") {
              turn.status = "stream_error";
              turn.error_type = evt.error?.type || "unknown";
            }
          }
        }
      } catch (err) {
        turn.status = "stream_error";
        turn.error_type = turn.error_type || "connection_lost";
      } finally {
        if (turn.status === "stream_error") {
          controller.enqueue(encoder.encode(STREAM_ERROR_MARK + "transient"));
        }
        turn.total_ms = Date.now() - startedAt;
        logTurn(turn);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
