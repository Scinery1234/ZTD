import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api';
import { useKeyboardViewport } from '../hooks/useKeyboardViewport';
import './AIHub.css';

/*
 * AIHub — MadeHappen's AI companion.
 *
 * Replaces the old bottom-right slide-over with a full-screen hub. A landing
 * screen offers the Task Assistant (natural-language add/edit/delete) plus five
 * coaching spaces. Every conversation runs beside a live rail of the user's real
 * tasks, so people can act on their to-do list while being coached, building
 * resilience, and getting executive-function support.
 */

const CONSENT_KEY = 'mh_ai_consent_v1';
const CONSENT_MAX_AGE_DAYS = 90;

const CRISIS_KEYWORDS = [
  'suicide', 'suicidal', 'kill myself', 'end my life', 'want to die',
  "don't want to live", 'dont want to live', 'self-harm', 'self harm',
  'hurt myself', 'cut myself', 'overdose', 'harm myself',
  'not worth living', 'better off dead',
];
const detectCrisis = (t) => CRISIS_KEYWORDS.some((k) => (t || '').toLowerCase().includes(k));

const CRISIS_RESOURCES = [
  { name: 'Lifeline', num: '13 11 14', desc: '24/7 crisis support' },
  { name: 'Beyond Blue', num: '1300 22 4636', desc: 'Mental health support' },
  { name: 'Emergency', num: '000', desc: 'Immediate danger' },
  { name: '13YARN', num: '13 92 76', desc: 'Aboriginal & Torres Strait Islander' },
];

// Tool catalogue. `assistant` is the task CRUD chat; the rest are coaches served
// by /api/coach. `steps` drives the little progress bar for structured coaches.
const TOOLS = [
  {
    id: 'assistant',
    kind: 'assistant',
    icon: '✨',
    accent: '#f97316',
    name: 'Task Assistant',
    tagline: 'Add, edit & organise',
    desc: 'Talk to your task list in plain English — “add buy milk tomorrow”, “make everything in Work urgent”, “delete my shopping tasks”.',
  },
  {
    id: 'cbt',
    kind: 'coach',
    icon: '🌿',
    accent: '#4a7c59',
    name: 'CBT Coach',
    tagline: 'Structured 10-step session',
    desc: 'Work through what’s troubling you with a warm, guided CBT process — and turn insights into real tasks.',
    steps: ['What’s Bothering You', 'Emotions & Behaviors', 'Beliefs', 'Challenge Beliefs', 'New Actions', 'Today’s Actions', 'Weekly Goals', 'Review Goals', 'Gratitude', 'Self-Love'],
    marker: 'Step',
  },
  {
    id: 'action',
    kind: 'coach',
    icon: '⚡',
    accent: '#d97706',
    name: 'Action Coach',
    tagline: 'When you can’t start',
    desc: 'For when you know what to do but can’t begin. Uncover the resistance and rebuild momentum.',
  },
  {
    id: 'exec',
    kind: 'coach',
    icon: '🧭',
    accent: '#0e7490',
    name: 'Executive Function Coach',
    tagline: 'For neurodivergent minds',
    desc: 'Think out loud, externalise the swirl, and let tasks land gently on your list so your mind can let them go.',
  },
  {
    id: 'charge',
    kind: 'coach',
    icon: '🌊',
    accent: '#2563eb',
    name: 'Reducing the Charge',
    tagline: 'Release what you carry',
    desc: 'Process emotional resistance and settle the nervous system, one gentle question at a time.',
  },
  {
    id: 'clarity',
    kind: 'coach',
    icon: '🧿',
    accent: '#7c3aed',
    name: 'Clarity Compass',
    tagline: '13-phase decision guide',
    desc: 'A guided process for decisions that actually feel like yours — ending in a first action on your list.',
    steps: ['Ground', 'Values', 'Aspiration', 'Barriers', 'Strategy', 'Tooling', 'Decision', 'Plan', 'Resistance', 'Break Down', 'Visualise', 'Schedule', 'First Action'],
    marker: 'Phase',
  },
];

const COACH_OPENERS = {
  cbt: 'Hi, I’m here with you. We can take this one step at a time. What’s been on your mind lately?',
  action: 'Hey, I’m here. What’s on your mind — what are you wanting to do but finding yourself resisting?',
  exec: 'Hi, I’m here with you. Take a breath — there’s no rush. How are you feeling right now, in this moment?',
  charge: 'Welcome. Whenever you’re ready: on a scale of 1 to 10, how would you rate the emotional charge you’re carrying right now?',
  clarity: 'Hi, I’m glad you’re here. Let’s find some clarity together — shall we begin?',
};

const ASSISTANT_WELCOME =
  'Hi! I can add, delete, and bulk-edit your tasks. Try “add buy milk and call the dentist tomorrow”, “make everything in Work urgent”, or “delete my shopping tasks”.';

// ── helpers ──────────────────────────────────────────────────────────────────
function renderBold(text) {
  return (text || '').split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{part}</React.Fragment>
  );
}

function toHistory(messages) {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
}

function isConsentValid() {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return false;
    const { ts } = JSON.parse(raw);
    return (Date.now() - ts) / 86400000 < CONSENT_MAX_AGE_DAYS;
  } catch {
    return false;
  }
}

// ── Crisis overlay ───────────────────────────────────────────────────────────
function CrisisOverlay({ onClose }) {
  return (
    <div className="aih-crisis" role="dialog" aria-label="Crisis support">
      <div className="aih-crisis__card">
        <div className="aih-crisis__emoji">💙</div>
        <h2>You’re not alone</h2>
        <p>It sounds like things may be really difficult right now. Please reach out to someone who can help.</p>
        {CRISIS_RESOURCES.map((r) => (
          <a key={r.name} className="aih-crisis__row" href={`tel:${r.num.replace(/\s/g, '')}`}>
            <span>
              <span className="aih-crisis__name">{r.name}</span>
              <span className="aih-crisis__desc">{r.desc}</span>
            </span>
            <span className="aih-crisis__num">{r.num}</span>
          </a>
        ))}
        <button className="aih-crisis__close" onClick={onClose}>I’m safe — continue</button>
      </div>
    </div>
  );
}

// ── Consent gate ─────────────────────────────────────────────────────────────
const CONSENT_ITEMS = [
  { k: 'notTherapy', t: 'This is coaching, not therapy', b: 'These tools offer AI-assisted reflection and coaching. They are not a substitute for professional mental health care.' },
  { k: 'ai', t: 'Responses are AI-generated', b: 'All coaching is powered by Claude (Anthropic). Use your own judgment.' },
  { k: 'private', t: 'This is your space', b: 'Your conversations and short memory notes are saved to your account so every chat picks up where you left off — even after closing the tab or switching devices. You’re in control: “Start fresh” clears a conversation, and the 🧠 Memory panel lets you delete anything remembered. Tasks you choose to keep are added to your task list.' },
  { k: 'age', t: 'I’m 18 years or older', b: 'These tools are designed for adults.' },
];

function ConsentGate({ onAccept, onCrisis }) {
  const [checks, setChecks] = useState({ notTherapy: false, ai: false, private: false, age: false });
  const all = Object.values(checks).every(Boolean);
  return (
    <div className="aih-consent">
      <div className="aih-consent__body">
        <div className="aih-eyebrow">MadeHappen · AI Hub</div>
        <h1>A few things to know first</h1>
        <p className="aih-consent__lead">Tick each one to continue.</p>
        {CONSENT_ITEMS.map(({ k, t, b }) => (
          <button
            key={k}
            type="button"
            className="aih-consent__item"
            onClick={() => setChecks((c) => ({ ...c, [k]: !c[k] }))}
          >
            <span className={`aih-check${checks[k] ? ' aih-check--on' : ''}`}>{checks[k] && '✓'}</span>
            <span>
              <span className="aih-consent__t">{t}</span>
              <span className="aih-consent__b">{b}</span>
            </span>
          </button>
        ))}
        <div className="aih-consent__crisis">
          If you’re going through a hard time,{' '}
          <button type="button" onClick={onCrisis}>support is available</button>.
        </div>
      </div>
      <div className="aih-consent__foot">
        <button className="aih-btn-primary" onClick={onAccept} disabled={!all}>Enter →</button>
      </div>
    </div>
  );
}

// ── Memory panel — view & delete what the hub remembers ─────────────────────
function memorySource(coachId) {
  if (!coachId || coachId === 'assistant') return { icon: '✨', name: 'Task Assistant' };
  const tool = TOOLS.find((t) => t.id === coachId);
  return tool ? { icon: tool.icon, name: tool.name } : { icon: '🧠', name: coachId };
}

function MemoryPanel({ onClose }) {
  const [notes, setNotes] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotes(await api.coachMemoryList());
    } catch (err) {
      setError(err.data?.token_expired ? 'Please sign in again.' : err.message);
      setNotes([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = async (id) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    try { await api.coachMemoryDelete(id); } catch { load(); }
  };

  const clearAll = async () => {
    setConfirmClear(false);
    setNotes([]);
    try { await api.coachMemoryClear(); } catch { load(); }
  };

  return (
    <div className="aih-memory" role="dialog" aria-label="Memory">
      <div className="aih-memory__card">
        <div className="aih-memory__head">
          <span className="aih-memory__title">🧠 Memory</span>
          <button className="aih-memory__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="aih-memory__lead">
          Things the hub has saved to remember you between conversations. Every
          coach and the task assistant share this memory. Delete anything you
          don’t want kept — or just tell a coach to “forget that”.
        </p>
        <div className="aih-memory__list">
          {notes === null && <div className="aih-memory__empty">Loading…</div>}
          {notes !== null && error && <div className="aih-memory__empty">{error}</div>}
          {notes !== null && !error && notes.length === 0 && (
            <div className="aih-memory__empty">
              Nothing saved yet. As you talk, important things — goals, themes,
              anything you ask it to remember — will appear here.
            </div>
          )}
          {(notes || []).map((n) => {
            const src = memorySource(n.coach_id);
            return (
              <div key={n.id} className="aih-memory__item">
                <div className="aih-memory__meta">
                  <span>{src.icon} {src.name}</span>
                  {n.created_at && <span>{n.created_at.slice(0, 10)}</span>}
                </div>
                <div className="aih-memory__content">{n.content}</div>
                <button className="aih-memory__del" onClick={() => remove(n.id)} title="Forget this">✕</button>
              </div>
            );
          })}
        </div>
        {(notes || []).length > 0 && (
          <div className="aih-memory__foot">
            {confirmClear ? (
              <>
                <span>Forget everything?</span>
                <button className="aih-memory__danger" onClick={clearAll}>Yes, forget all</button>
                <button onClick={() => setConfirmClear(false)}>Cancel</button>
              </>
            ) : (
              <button className="aih-memory__danger" onClick={() => setConfirmClear(true)}>
                Forget everything
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Live task rail ───────────────────────────────────────────────────────────
const PRIORITY_LABEL = { urgent: 'Urgent', today: 'Today', tomorrow: 'Tomorrow', later: 'Later' };

function TaskRail({ tasks, highlightIds }) {
  const list = Array.isArray(tasks) ? tasks : [];
  return (
    <aside className="aih-rail" aria-label="Your tasks">
      <div className="aih-rail__head">
        <span>Your tasks</span>
        <span className="aih-rail__count">{list.length}</span>
      </div>
      <div className="aih-rail__list">
        {list.length === 0 && <div className="aih-rail__empty">No tasks yet. Anything you decide to keep will appear here.</div>}
        {list.map((t) => (
          <div key={t.id} className={`aih-rail__item${highlightIds.has(t.id) ? ' aih-rail__item--new' : ''}`}>
            <div className="aih-rail__desc">{t.description}</div>
            <div className="aih-rail__meta">
              {t.priority && <span className={`aih-pill aih-pill--${t.priority}`}>{PRIORITY_LABEL[t.priority] || t.priority}</span>}
              {t.due && <span className="aih-rail__due">📅 {t.due}</span>}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ── Conversation (shared by assistant + coaches) ─────────────────────────────
function Conversation({ tool, hatId, tasks, onTasksChanged, onBack, onCrisis }) {
  const isCoach = tool.kind === 'coach';
  const seed = isCoach
    ? [{ role: 'assistant', content: COACH_OPENERS[tool.id] }]
    : [{ role: 'assistant', content: ASSISTANT_WELCOME }];

  const [messages, setMessages] = useState(null); // null = loading saved chat
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(1);
  const [railOpen, setRailOpen] = useState(false); // mobile toggle
  const [justAdded, setJustAdded] = useState(new Set());
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const detectStepIn = useCallback((text) => {
    if (!tool.marker) return null;
    const m = (text || '').match(new RegExp(`\\*\\*${tool.marker}\\s+(\\d+)`, 'i'));
    return m ? parseInt(m[1], 10) : null;
  }, [tool.marker]);

  // Chats are saved server-side per tool — resume where we left off, so
  // closing the tab (or switching devices) never loses the conversation.
  useEffect(() => {
    let alive = true;
    api.chatThreadGet(tool.id)
      .then((res) => {
        if (!alive) return;
        const saved = Array.isArray(res.messages) ? res.messages : [];
        if (saved.length === 0) {
          setMessages(seed);
          return;
        }
        setMessages(saved);
        // Restore the structured-coach progress bar from the transcript.
        let s = 1;
        saved.forEach((m) => {
          if (m.role === 'assistant') {
            const d = detectStepIn(m.content);
            if (d) s = Math.max(s, d);
          }
        });
        setStep(s);
      })
      .catch(() => { if (alive) setMessages(seed); });
    return () => { alive = false; };
  }, [tool.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const startFresh = useCallback(async () => {
    try { await api.chatThreadClear(tool.id); } catch { /* clearing is best-effort */ }
    setMessages(seed);
    setStep(1);
    inputRef.current?.focus();
  }, [tool.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Stay pinned to the latest messages when the pane resizes (mobile keyboard
  // opening/closing) — but only if the user was already reading the bottom.
  const nearBottomRef = useRef(true);
  const onThreadScroll = () => {
    const el = listRef.current;
    if (el) nearBottomRef.current = (el.scrollHeight - el.clientHeight - el.scrollTop) < 160;
  };
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track newly added task ids so the rail can pulse them briefly.
  const prevIds = useRef(new Set((tasks || []).map((t) => t.id)));
  useEffect(() => {
    const cur = new Set((tasks || []).map((t) => t.id));
    const fresh = [...cur].filter((id) => !prevIds.current.has(id));
    if (fresh.length) {
      setJustAdded(new Set(fresh));
      const timer = setTimeout(() => setJustAdded(new Set()), 4000);
      prevIds.current = cur;
      return () => clearTimeout(timer);
    }
    prevIds.current = cur;
  }, [tasks]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !messages) return;
    if (isCoach && detectCrisis(text)) onCrisis();

    const history = toHistory(messages);
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setInput('');
    setBusy(true);
    try {
      if (isCoach) {
        const res = await api.coach(tool.id, text, hatId, history);
        if (res.crisis) onCrisis();
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: res.reply,
          tasksAdded: res.tasks_added || [],
        }]);
        const s = detectStepIn(res.reply);
        if (s) setStep((cur) => Math.max(cur, s));
        if ((res.tasks_added || []).length > 0) onTasksChanged?.();
      } else {
        const res = await api.chat(text, hatId, history);
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: res.reply,
          actions: res.actions || [],
          undo_token: res.undo_available ? res.undo_token : null,
        }]);
        if ((res.actions || []).length > 0) onTasksChanged?.();
      }
    } catch (err) {
      const msg = err.data?.unavailable
        ? 'The AI isn’t configured on this server yet.'
        : `Sorry, something went wrong: ${err.message}`;
      setMessages((prev) => [...prev, { role: 'assistant', content: msg, error: true }]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, messages, isCoach, tool.id, hatId, onTasksChanged, onCrisis, detectStepIn]);

  const undo = useCallback(async (index, token) => {
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, undoing: true } : m)));
    try {
      const res = await api.chatUndo(token);
      setMessages((prev) => prev.map((m, i) =>
        i === index ? { ...m, undoing: false, undone: true, undo_token: null } : m));
      setMessages((prev) => [...prev, { role: 'assistant', content: res.message || 'Undone.' }]);
      onTasksChanged?.();
    } catch (err) {
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, undoing: false } : m)));
      setMessages((prev) => [...prev, { role: 'assistant', content: `Couldn’t undo: ${err.message}`, error: true }]);
    }
  }, [onTasksChanged]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const totalSteps = tool.steps?.length || 0;

  return (
    <div className="aih-convo" style={{ '--accent': tool.accent }}>
      <header className="aih-convo__head">
        <button className="aih-back" onClick={onBack} aria-label="Back to hub">←</button>
        <span className="aih-convo__icon">{tool.icon}</span>
        <div className="aih-convo__titles">
          <div className="aih-convo__name">{tool.name}</div>
          <div className="aih-convo__sub">
            {totalSteps ? `${tool.marker} ${Math.min(step, totalSteps)} of ${totalSteps} — ${tool.steps[Math.min(step, totalSteps) - 1]}` : tool.tagline}
          </div>
        </div>
        <div className="aih-convo__actions">
          <button className="aih-rail-toggle" onClick={() => setRailOpen((v) => !v)}>
            {railOpen ? 'Hide tasks' : 'Tasks'}
            {tasks?.length ? <span className="aih-rail-toggle__count">{tasks.length}</span> : null}
          </button>
          <button
            className="aih-fresh"
            onClick={startFresh}
            disabled={busy || !messages}
            title="Start a fresh conversation (your saved chat is cleared; memory notes are kept)"
          >↺<span className="aih-fresh__label"> New</span></button>
          <button className="aih-sos" onClick={onCrisis} title="Crisis support">🆘</button>
        </div>
      </header>

      {totalSteps > 0 && (
        <div className="aih-progress">
          {tool.steps.map((_, i) => (
            <span key={i} className={`aih-progress__dot${i < step ? ' aih-progress__dot--on' : ''}`} />
          ))}
        </div>
      )}

      <div className="aih-convo__body">
        <div className="aih-thread" ref={listRef} onScroll={onThreadScroll}>
          {messages === null && (
            <div className="aih-msg aih-msg--assistant">
              <div className="aih-bubble aih-bubble--typing"><span></span><span></span><span></span></div>
            </div>
          )}
          {(messages || []).map((m, i) => (
            <div key={i} className={`aih-msg aih-msg--${m.role}${m.error ? ' aih-msg--error' : ''}`}>
              <div className="aih-bubble">
                {m.role === 'assistant' ? renderBold(m.content) : m.content}
              </div>
              {Array.isArray(m.tasksAdded) && m.tasksAdded.length > 0 && (
                <div className="aih-added">
                  {m.tasksAdded.map((t, j) => (
                    <span key={j} className="aih-added__chip">＋ {t.description}</span>
                  ))}
                </div>
              )}
              {m.undo_token != null && !m.undone && (
                <button className="aih-undo" onClick={() => undo(i, m.undo_token)} disabled={m.undoing}>
                  {m.undoing ? 'Undoing…' : '↩ Undo'}
                </button>
              )}
              {m.undone && <span className="aih-undone">Undone</span>}
            </div>
          ))}
          {busy && (
            <div className="aih-msg aih-msg--assistant">
              <div className="aih-bubble aih-bubble--typing"><span></span><span></span><span></span></div>
            </div>
          )}
        </div>

        <div className={`aih-rail-wrap${railOpen ? ' aih-rail-wrap--open' : ''}`}>
          <TaskRail tasks={tasks} highlightIds={justAdded} />
        </div>
      </div>

      <div className="aih-composer">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isCoach ? 'Type your response…' : 'Ask me to add, edit, or delete tasks…'}
          rows={1}
          disabled={busy || messages === null}
        />
        <button onClick={send} disabled={busy || !input.trim() || messages === null} aria-label="Send">➤</button>
      </div>
    </div>
  );
}

// ── Hub landing ──────────────────────────────────────────────────────────────
function Hub({ onSelect, onCrisis, onOpenMemory }) {
  const assistant = TOOLS.find((t) => t.kind === 'assistant');
  const coaches = TOOLS.filter((t) => t.kind === 'coach');
  return (
    <div className="aih-hub">
      <div className="aih-hub__intro">
        <div className="aih-eyebrow">MadeHappen · AI Hub</div>
        <h1>How can I help right now?</h1>
        <p>Manage your tasks, or step into a coaching space. Each conversation stays beside your real task list.</p>
      </div>

      <button className="aih-card aih-card--feature" style={{ '--accent': assistant.accent }} onClick={() => onSelect(assistant)}>
        <span className="aih-card__icon">{assistant.icon}</span>
        <span className="aih-card__body">
          <span className="aih-card__name">{assistant.name}</span>
          <span className="aih-card__desc">{assistant.desc}</span>
        </span>
        <span className="aih-card__arrow">→</span>
      </button>

      <div className="aih-hub__label">Coaching, resilience & focus</div>
      <div className="aih-grid">
        {coaches.map((t) => (
          <button key={t.id} className="aih-card" style={{ '--accent': t.accent }} onClick={() => onSelect(t)}>
            <span className="aih-card__icon">{t.icon}</span>
            <span className="aih-card__body">
              <span className="aih-card__name">{t.name}</span>
              <span className="aih-card__tagline">{t.tagline}</span>
              <span className="aih-card__desc">{t.desc}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="aih-hub__foot">
        <span>🆘 In crisis? <a href="tel:131114">Lifeline 13 11 14</a> · <button onClick={onCrisis}>All resources →</button></span>
        <span className="aih-hub__note">
          <button className="aih-hub__memory-btn" onClick={onOpenMemory}>🧠 Memory</button>
          {' · '}AI coaching · not therapy
        </span>
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
// Two shapes: the default floating FAB + modal overlay used inside the task
// app, and `standalone` — the same hub filling its container, used by the
// dedicated /coach page (no FAB, no close button, no Escape-to-close).
export default function AIHub({ hatId, tasks, onTasksChanged, standalone = false }) {
  const [open, setOpen] = useState(false);
  const [consented, setConsented] = useState(() => isConsentValid());
  const [active, setActive] = useState(null); // active tool object, or null = hub
  const [crisis, setCrisis] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  // Size the hub to the visible viewport so the iOS keyboard doesn't hide
  // the composer or the latest messages.
  useKeyboardViewport(standalone || open);

  const showCrisis = useCallback(() => setCrisis(true), []);

  // Lock background scroll while the hub is open (overlay mode only).
  useEffect(() => {
    if (standalone || !open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open, standalone]);

  useEffect(() => {
    if (standalone) return undefined;
    const onEsc = (e) => { if (e.key === 'Escape' && open) close(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open, standalone]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => { setOpen(false); setActive(null); }, []);

  const acceptConsent = useCallback(() => {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ ts: Date.now() })); } catch { /* ignore */ }
    setConsented(true);
  }, []);

  const railTasks = useMemo(() => {
    if (!Array.isArray(tasks)) return [];
    if (hatId == null) return tasks;
    return tasks.filter((t) => t.hat_id === hatId);
  }, [tasks, hatId]);

  if (!standalone && !open) {
    return (
      <button className="aih-fab" onClick={() => setOpen(true)} aria-label="Open AI hub" title="AI Hub — assistant & coaching">
        ✨
      </button>
    );
  }

  const content = (
    <>
      {crisis && <CrisisOverlay onClose={() => setCrisis(false)} />}
      {memoryOpen && <MemoryPanel onClose={() => setMemoryOpen(false)} />}
      {!consented ? (
        <ConsentGate onAccept={acceptConsent} onCrisis={showCrisis} />
      ) : active ? (
        <Conversation
          key={active.id}
          tool={active}
          hatId={hatId}
          tasks={railTasks}
          onTasksChanged={onTasksChanged}
          onBack={() => setActive(null)}
          onCrisis={showCrisis}
        />
      ) : (
        <Hub onSelect={setActive} onCrisis={showCrisis} onOpenMemory={() => setMemoryOpen(true)} />
      )}
    </>
  );

  if (standalone) {
    return (
      <div className="aih-modal aih-modal--standalone" role="main" aria-label="AI Coach">
        {content}
      </div>
    );
  }

  return (
    <div className="aih-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="aih-modal" role="dialog" aria-label="AI Hub">
        <button className="aih-close" onClick={close} aria-label="Close">✕</button>
        {content}
      </div>
    </div>
  );
}
