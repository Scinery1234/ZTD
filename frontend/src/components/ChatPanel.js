import React, { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import './ChatPanel.css';

const WELCOME = {
  role: 'assistant',
  content:
    "Hi! I can add, delete, and bulk-edit your tasks. Try “add buy milk and call the dentist tomorrow”, " +
    "“make everything in Work urgent”, or “delete my shopping tasks”.",
};

// Only plain text turns are sent back as history (keeps the request small).
function toHistory(messages) {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
}

export default function ChatPanel({ hatId, onTasksChanged }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history = toHistory(messages);
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setInput('');
    setBusy(true);
    try {
      const res = await api.chat(text, hatId, history);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.reply,
          actions: res.actions || [],
          undo_token: res.undo_available ? res.undo_token : null,
        },
      ]);
      if ((res.actions || []).length > 0) onTasksChanged?.();
    } catch (err) {
      const msg = err.data?.unavailable
        ? 'AI chat isn’t configured on this server yet.'
        : `Sorry, something went wrong: ${err.message}`;
      setMessages((prev) => [...prev, { role: 'assistant', content: msg, error: true }]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, messages, hatId, onTasksChanged]);

  const undo = useCallback(
    async (index, token) => {
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, undoing: true } : m)));
      try {
        const res = await api.chatUndo(token);
        setMessages((prev) =>
          prev.map((m, i) =>
            i === index ? { ...m, undoing: false, undone: true, undo_token: null } : m
          )
        );
        setMessages((prev) => [...prev, { role: 'assistant', content: res.message || 'Undone.' }]);
        onTasksChanged?.();
      } catch (err) {
        setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, undoing: false } : m)));
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Couldn’t undo: ${err.message}`, error: true },
        ]);
      }
    },
    [onTasksChanged]
  );

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (!open) {
    return (
      <button
        className="chat-fab"
        onClick={() => setOpen(true)}
        aria-label="Open AI task assistant"
        title="AI task assistant"
      >
        ✨
      </button>
    );
  }

  return (
    <div className="chat-panel" role="dialog" aria-label="AI task assistant">
      <div className="chat-panel__header">
        <span className="chat-panel__title">✨ AI Assistant</span>
        <button className="chat-panel__close" onClick={() => setOpen(false)} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="chat-panel__messages" ref={listRef}>
        {messages.map((m, i) => (
          <div
            key={i}
            className={`chat-msg chat-msg--${m.role}${m.error ? ' chat-msg--error' : ''}`}
          >
            <div className="chat-msg__bubble">{m.content}</div>
            {m.undo_token != null && !m.undone && (
              <button
                className="chat-msg__undo"
                onClick={() => undo(i, m.undo_token)}
                disabled={m.undoing}
              >
                {m.undoing ? 'Undoing…' : '↩ Undo'}
              </button>
            )}
            {m.undone && <span className="chat-msg__undone">Undone</span>}
          </div>
        ))}
        {busy && (
          <div className="chat-msg chat-msg--assistant">
            <div className="chat-msg__bubble chat-msg__bubble--typing">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
      </div>

      <div className="chat-panel__input">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask me to add, edit, or delete tasks…"
          rows={1}
          disabled={busy}
        />
        <button onClick={send} disabled={busy || !input.trim()} aria-label="Send">
          ➤
        </button>
      </div>
    </div>
  );
}
