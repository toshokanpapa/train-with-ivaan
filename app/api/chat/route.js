import { IVAAN_SYSTEM_PROMPT } from "../../../lib/ivaan-prompt";

export const runtime = "nodejs";
export const maxDuration = 60; // seconds — Vercel Hobby-tier ceiling; raises the default 10s cap

const MAX_TURNS = 90; // hard backstop, never mentioned to the user
const MAX_MESSAGE_CHARS = 6000;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return new Response("Bad request", { status: 400 });
  }

  // Basic shape + size checks on every message.
  for (const m of messages) {
    if (
      !m ||
      (m.role !== "user" && m.role !== "assistant") ||
      typeof m.content !== "string" ||
      m.content.length > MAX_MESSAGE_CHARS
    ) {
      return new Response("Bad request", { status: 400 });
    }
  }

  // Hard cap as a pure cost/abuse backstop — never surfaced to the user.
  if (messages.length > MAX_TURNS) {
    const closing =
      "All the ocean will ever hear of the frog is its song. We've covered a lot of ground today — I'd rather leave what we found here than stretch it thin. Thank you for the conversation.";
    return new Response(closing, { status: 200 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response("Server is not configured with an API key.", { status: 500 });
  }

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: IVAAN_SYSTEM_PROMPT,
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!anthropicRes.ok || !anthropicRes.body) {
    const errText = await anthropicRes.text().catch(() => "");
    return new Response("Upstream error: " + errText, { status: 502 });
  }

  // Parse Anthropic's SSE stream and re-emit just the plain text deltas,
  // so the client can read this as a simple text stream with no SSE parsing of its own.
  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
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
            try {
              const evt = JSON.parse(jsonStr);
              if (
                evt.type === "content_block_delta" &&
                evt.delta &&
                evt.delta.type === "text_delta" &&
                typeof evt.delta.text === "string"
              ) {
                controller.enqueue(encoder.encode(evt.delta.text));
              }
            } catch {
              // Ignore malformed lines rather than breaking the stream.
            }
          }
        }
      } catch (err) {
        // Stream ends; client just sees what arrived.
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
