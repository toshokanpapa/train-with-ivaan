"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "ivaan-conversation-v1";
const CLIENT_TIMEOUT_MS = 65000; // just past the server's 60s ceiling
const THINKING_PHRASES = ["Pondering", "Sitting with that", "Turning it over", "Listening"];

function renderMessageText(text) {
  // Lines like: > *Your project is not falling apart.*
  // render as a visually distinct beat. Everything else is plain text.
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const match = line.match(/^>\s*\*(.+)\*\s*$/);
    if (match) {
      return (
        <div className="beat" key={i}>
          {match[1]}
        </div>
      );
    }
    return line.length ? <div key={i}>{line}</div> : <div key={i}>&nbsp;</div>;
  });
}

export default function Page() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  const [thinkingPhrase, setThinkingPhrase] = useState(THINKING_PHRASES[0]);
  const [lastFailedHistory, setLastFailedHistory] = useState(null);
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

  async function sendTurn(historyBeforeThisTurn, userText) {
    const next = userText
      ? [...historyBeforeThisTurn, { role: "user", content: userText }]
      : historyBeforeThisTurn;

    if (userText) setMessages(next);
    setStreaming(true);
    setLastFailedHistory(null);

    let assistantText = "";
    let gotAnyText = false;
    setMessages((cur) => [...cur, { role: "assistant", content: "" }]);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          messages: next.length
            ? next
            : [{ role: "user", content: "(begin)" }],
        }),
      });

      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) gotAnyText = true;
        assistantText += chunk;
        setMessages((cur) => {
          const copy = [...cur];
          copy[copy.length - 1] = { role: "assistant", content: assistantText };
          return copy;
        });
      }

      if (!gotAnyText) throw new Error("Empty response");
    } catch (err) {
      const timedOut = err && err.name === "AbortError";
      setMessages((cur) => {
        const copy = [...cur];
        copy[copy.length - 1] = {
          role: "assistant",
          content: timedOut
            ? "This is taking longer than expected, and I'd rather say so than leave you waiting. Nothing you wrote is lost."
            : "Something interrupted the connection just then. Nothing you wrote is lost.",
        };
        return copy;
      });
      setLastFailedHistory(next);
    } finally {
      clearTimeout(timeoutId);
      setStreaming(false);
    }
  }

  function handleRetry() {
    if (!lastFailedHistory || streaming) return;
    // Drop the failed assistant placeholder before retrying the same turn.
    setMessages((cur) => cur.slice(0, -1));
    sendTurn(lastFailedHistory);
  }

  function handleSend() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    sendTurn(messages, text);
  }

  function handleDownload() {
    const lines = messages.map((m) =>
      m.role === "user" ? `You:\n${m.content}\n` : `Ivaan:\n${m.content}\n`
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ivaan-conversation.txt";
    a.click();
    URL.revokeObjectURL(url);
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
            ) : (
              renderMessageText(m.content)
            )}
          </div>
        ))}
        {lastFailedHistory && !streaming && (
          <div style={{ marginTop: -8, marginBottom: 20 }}>
            <button onClick={handleRetry} className="retry-button">
              Try again
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write as much or as little as you like..."
          disabled={streaming}
        />
        <button onClick={handleSend} disabled={streaming || !input.trim()}>
          Send
        </button>
      </div>

      <div className="footer">
        <span>Private — nothing is stored.</span>
        <button onClick={handleDownload}>Download conversation</button>
      </div>
    </div>
  );
}
