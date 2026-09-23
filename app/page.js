"use client";

import { useEffect, useRef, useState } from "react";
import { toDisplayLines } from "../lib/display-text";
import { NOTICES, STREAM_ERROR_MARK } from "../lib/errors";

const STORAGE_KEY = "ivaan-conversation-v1";
const MAX_MESSAGE_CHARS = 6000; // one message; the relay trims past this only as a backstop
const COUNTER_FROM_CHARS = 5000; // the character counter appears from here
const IDLE_TIMEOUT_MS = 75000; // give up only after 75s with no new words arriving
const THINKING_PHRASES = ["Pondering", "Sitting with that", "Turning it over", "Listening"];

function renderSegments(segments) {
  return segments.map((s, j) =>
    s.style === "strong" ? (
      <strong key={j}>{s.text}</strong>
    ) : s.style === "em" ? (
      <em key={j}>{s.text}</em>
    ) : (
      <span key={j}>{s.text}</span>
    )
  );
}

function renderIvaanText(text) {
  // Lines like: > *Your project is not falling apart.*
  // render as a visually distinct beat. Markdown symbols are never shown raw.
  return toDisplayLines(text).map((line, i) => {
    if (line.type === "blank") return <div key={i}>&nbsp;</div>;
    return (
      <div className={line.type === "beat" ? "beat" : undefined} key={i}>
        {renderSegments(line.segments)}
      </div>
    );
  });
}

function plainIvaanText(text) {
  // The downloaded transcript reads like the screen: no markdown symbols.
  return toDisplayLines(text)
    .map((line) => line.segments.map((s) => s.text).join(""))
    .join("\n");
}

function renderUserText(text) {
  // What the person typed is shown exactly as typed.
  return text.split("\n").map((line, i) =>
    line.length ? <div key={i}>{line}</div> : <div key={i}>&nbsp;</div>
  );
}

class TurnError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // "transient" | "timeout" | "fatal"
  }
}

export default function Page() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [pasteCut, setPasteCut] = useState(false); // a paste didn't fully fit in the box
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  const [thinkingPhrase, setThinkingPhrase] = useState(THINKING_PHRASES[0]);
  const [notice, setNotice] = useState(null); // { kind, history, partial } after a failed turn
  const bottomRef = useRef(null);

  // Restore from this browser tab's session storage on load (refresh-survival guardrail).
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed);
          setStarted(true);
          return;
        }
      }
    } catch {
      // Ignore — just start fresh.
    }
  }, []);

  // Persist to sessionStorage (device-only, tab-scoped, cleared when the tab closes).
  useEffect(() => {
    try {
      if (messages.length > 0) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      }
    } catch {
      // Non-fatal if storage is unavailable.
    }
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // Rotate the "thinking" phrase gently while waiting for the first token.
  useEffect(() => {
    if (!streaming) return;
    let i = 0;
    setThinkingPhrase(THINKING_PHRASES[0]);
    const id = setInterval(() => {
      i = (i + 1) % THINKING_PHRASES.length;
      setThinkingPhrase(THINKING_PHRASES[i]);
    }, 2600);
    return () => clearInterval(id);
  }, [streaming]);

  async function beginConversation() {
    setStarted(true);
    await sendTurn([]);
  }

  // One request to the relay. Calls onText with the reply so far as it streams in.
  // Throws a TurnError ("transient", "timeout" or "fatal") if the reply doesn't complete.
  async function requestReply(payload, onText) {
    const controller = new AbortController();
    let idleId;
    let timedOut = false;
    const armIdleTimer = () => {
      clearTimeout(idleId);
      idleId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, IDLE_TIMEOUT_MS);
    };

    armIdleTimer();
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ messages: payload }),
      });

      if (!res.ok || !res.body) {
        const kind = await res.json().then((b) => b.kind).catch(() => "transient");
        throw new TurnError(kind === "fatal" ? "fatal" : "transient");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let received = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleTimer(); // every piece of the reply resets the 75s clock
        received += decoder.decode(value, { stream: true });
        // The relay marks a mid-reply failure after the text; never display the marker.
        onText(received.split("\u0000")[0]);
        if (received.includes(STREAM_ERROR_MARK)) throw new TurnError("transient");
      }

      if (!received) throw new TurnError("transient");
    } catch (err) {
      if (err instanceof TurnError) throw err;
      throw new TurnError(timedOut ? "timeout" : "transient");
    } finally {
      clearTimeout(idleId);
    }
  }

  async function sendTurn(historyBeforeThisTurn, userText) {
    const next = userText
      ? [...historyBeforeThisTurn, { role: "user", content: userText }]
      : historyBeforeThisTurn;

    if (userText) setMessages(next);
    setStreaming(true);
    setNotice(null);
    setMessages((cur) => [...cur, { role: "assistant", content: "" }]);

    let shown = "";
    const onText = (text) => {
      shown = text;
      setMessages((cur) => {
        const copy = [...cur];
        copy[copy.length - 1] = { role: "assistant", content: text };
        return copy;
      });
    };
    const payload = next.length ? next : [{ role: "user", content: "(begin)" }];

    try {
      try {
        await requestReply(payload, onText);
      } catch (err) {
        // One silent retry for a brief hiccup, but only if nothing was shown yet.
        if (err.kind !== "transient" || shown) throw err;
        await requestReply(payload, onText);
      }
    } catch (err) {
      // The error itself never enters the conversation; words already shown stay.
      if (!shown) setMessages((cur) => cur.slice(0, -1));
      setNotice({ kind: err.kind || "transient", history: next, partial: Boolean(shown) });
    } finally {
      setStreaming(false);
    }
  }

  function handleRetry() {
    if (!notice || notice.kind === "fatal" || streaming) return;
    // Drop a partial reply before asking again for the same turn.
    if (notice.partial) setMessages((cur) => cur.slice(0, -1));
    sendTurn(notice.history);
  }

  function handleSend() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setPasteCut(false);
    sendTurn(messages, text);
  }

  function handleDownload() {
    const lines = messages.map((m) =>
      m.role === "user" ? `You:\n${m.content}\n` : `Ivaan:\n${plainIvaanText(m.content)}\n`
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ivaan-conversation.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleInputChange(e) {
    setInput(e.target.value);
    if (e.target.value.length < MAX_MESSAGE_CHARS) setPasteCut(false);
  }

  function handlePaste(e) {
    // The box stops at the limit on its own; this just tells the person when a paste was cut.
    const pasted = e.clipboardData?.getData("text") ?? "";
    const { selectionStart, selectionEnd, value } = e.target;
    const resulting = value.length - (selectionEnd - selectionStart) + pasted.length;
    if (resulting > MAX_MESSAGE_CHARS) setPasteCut(true);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!started) {
    return (
      <div className="shell">
        <div className="header">
          <h1>Ivaan</h1>
          <p>A space to practice talking with a machine — and, through that, with yourself.</p>
        </div>
        <p style={{ lineHeight: 1.6 }}>
          Nothing here is stored or sent anywhere. If you'd like to keep any of it, you can
          download the conversation at any point.
        </p>
        <div className="composer" style={{ borderTop: "none", paddingTop: 20 }}>
          <button onClick={beginConversation} disabled={streaming}>
            Begin
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="header">
        <h1>Ivaan</h1>
        <p>A space to practice talking with a machine — and, through that, with yourself.</p>
      </div>

      <div className="messages">
        {messages.map((m, i) => (
          <div className={`msg ${m.role === "user" ? "user" : "ivaan"}`} key={i}>
            <span className="label">{m.role === "user" ? "You" : "Ivaan"}</span>
            {m.role === "assistant" && m.content === "" && streaming && i === messages.length - 1 ? (
              <span className="typing">{thinkingPhrase}...</span>
            ) : m.role === "user" ? (
              renderUserText(m.content)
            ) : (
              renderIvaanText(m.content)
            )}
          </div>
        ))}
        {notice && !streaming && (
          <div className="notice">
            <div>{NOTICES[notice.kind]}</div>
            {notice.kind !== "fatal" && (
              <button onClick={handleRetry} className="retry-button">
                Try again
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={handleInputChange}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder="Write as much or as little as you like..."
          disabled={streaming}
        />
        <button onClick={handleSend} disabled={streaming || !input.trim()}>
          Send
        </button>
      </div>
      {(input.length >= COUNTER_FROM_CHARS || pasteCut) && (
        <div className="composer-meta">
          {pasteCut && (
            <span>
              Your paste was longer than {MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters, so the
              rest wasn't added. You could send it in two parts.
            </span>
          )}
          <span className="count">
            {input.length.toLocaleString("en-US")} / {MAX_MESSAGE_CHARS.toLocaleString("en-US")}
          </span>
        </div>
      )}

      <div className="footer">
        <span>Private — nothing is stored.</span>
        <button onClick={handleDownload}>Download conversation</button>
      </div>
    </div>
  );
}
