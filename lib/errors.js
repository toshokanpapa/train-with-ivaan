// Shared between the relay (route.js) and the page (page.js).
// The relay never sends raw error text to the browser — only one of these kinds.
//   transient: worth retrying (busy, rate-limited, network hiccup, cut off mid-reply)
//   fatal:     retrying won't help (missing key, billing, bad model name, malformed request)

// Appended to a streamed reply when it fails partway through.
// \u0000 can't appear in anything Claude writes, so it can't be confused with a reply.
export const STREAM_ERROR_MARK = "\u0000IVAAN_ERROR:";

// What the person sees, by cause. Never saved into the conversation sent to Claude.
export const NOTICES = {
  transient: "Ivaan couldn't reply just now. Your message is saved.",
  timeout: "No reply yet, which sometimes happens when things are busy. Your message is saved.",
  fatal:
    "Ivaan is unavailable at the moment. Your conversation is safe in this tab, and you can download it below. If you're in a workshop, let the facilitator know.",
};
