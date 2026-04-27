import React, { useState, useRef, useEffect, useCallback } from 'react';
import './LooseThreads.css';

const STORAGE_KEY = 'ztd_loose_threads';
const MAX_OPEN = 3;

function loadNotes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveNotes(notes) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getTitle(html) {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 42) || 'Untitled';
}

function formatDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function NoteEditor({ note, onUpdate, onClose }) {
  const editorRef = useRef(null);
  const noteIdRef = useRef(note.id);

  useEffect(() => {
    if (note.id !== noteIdRef.current && editorRef.current) {
      editorRef.current.innerHTML = note.content;
      noteIdRef.current = note.id;
    }
  });

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = note.content;
    }
    // only on mount / note id change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      onUpdate(note.id, editorRef.current.innerHTML);
    }
  }, [note.id, onUpdate]);

  const exec = (cmd) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, null);
  };

  return (
    <div className="lt-editor">
      <div className="lt-editor-header">
        <span className="lt-editor-title">{getTitle(note.content)}</span>
        <button className="lt-close-btn" onClick={() => onClose(note.id)} title="Close">×</button>
      </div>
      <div className="lt-toolbar">
        <button
          className="lt-toolbar-btn"
          onMouseDown={e => { e.preventDefault(); exec('bold'); }}
          title="Bold"
        >
          <strong>B</strong>
        </button>
        <button
          className="lt-toolbar-btn lt-toolbar-btn--italic"
          onMouseDown={e => { e.preventDefault(); exec('italic'); }}
          title="Italic"
        >
          I
        </button>
        <button
          className="lt-toolbar-btn"
          onMouseDown={e => { e.preventDefault(); exec('insertUnorderedList'); }}
          title="Bullet list"
        >
          •—
        </button>
        <button
          className="lt-toolbar-btn"
          onMouseDown={e => { e.preventDefault(); exec('insertOrderedList'); }}
          title="Numbered list"
        >
          1.
        </button>
        <button
          className="lt-toolbar-btn lt-toolbar-btn--strike"
          onMouseDown={e => { e.preventDefault(); exec('strikeThrough'); }}
          title="Strikethrough"
        >
          S
        </button>
      </div>
      <div
        ref={editorRef}
        className="lt-editor-body"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        data-placeholder="Write here…"
      />
    </div>
  );
}

export default function LooseThreads() {
  const [notes, setNotes] = useState(loadNotes);
  const [openIds, setOpenIds] = useState([]);
  const [collapsed, setCollapsed] = useState(false);

  const persistNotes = (updated) => {
    setNotes(updated);
    saveNotes(updated);
  };

  const createNote = () => {
    const note = { id: generateId(), content: '', updatedAt: Date.now() };
    const updated = [note, ...notes];
    persistNotes(updated);
    setOpenIds(prev => [note.id, ...prev].slice(0, MAX_OPEN));
  };

  const openNote = (id) => {
    setOpenIds(prev => {
      if (prev.includes(id)) return prev;
      return [id, ...prev].slice(0, MAX_OPEN);
    });
  };

  const closeNote = (id) => {
    setOpenIds(prev => prev.filter(x => x !== id));
  };

  const updateNote = useCallback((id, content) => {
    setNotes(prev => {
      const updated = prev.map(n =>
        n.id === id ? { ...n, content, updatedAt: Date.now() } : n
      );
      saveNotes(updated);
      return updated;
    });
  }, []);

  const deleteNote = (id) => {
    setOpenIds(prev => prev.filter(x => x !== id));
    persistNotes(notes.filter(n => n.id !== id));
  };

  const openNotes = openIds.map(id => notes.find(n => n.id === id)).filter(Boolean);
  const closedNotes = notes.filter(n => !openIds.includes(n.id));

  return (
    <aside className={`lt-panel${collapsed ? ' lt-panel--collapsed' : ''}`}>
      <div className="lt-panel-header">
        {!collapsed && <span className="lt-panel-title">Loose Threads</span>}
        <div className="lt-panel-actions">
          {!collapsed && (
            <button className="lt-new-btn" onClick={createNote} title="New note">
              + New
            </button>
          )}
          <button
            className="lt-collapse-btn"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '«' : '»'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="lt-panel-body">
          {openNotes.length === 0 && notes.length === 0 && (
            <div className="lt-empty">
              <p>No notes yet.</p>
              <button className="lt-empty-btn" onClick={createNote}>
                Create a note
              </button>
            </div>
          )}

          {openNotes.length === 0 && notes.length > 0 && (
            <div className="lt-hint">Click a note below to open it.</div>
          )}

          <div className="lt-editors">
            {openNotes.map(note => (
              <NoteEditor
                key={note.id}
                note={note}
                onUpdate={updateNote}
                onClose={closeNote}
              />
            ))}
          </div>

          {openNotes.length < MAX_OPEN && openNotes.length > 0 && closedNotes.length > 0 && (
            <div className="lt-slot-hint">
              {MAX_OPEN - openNotes.length} slot{MAX_OPEN - openNotes.length !== 1 ? 's' : ''} remaining
            </div>
          )}

          {notes.length > 0 && (
            <div className="lt-list">
              {closedNotes.length > 0 && (
                <div className="lt-list-label">Saved notes</div>
              )}
              {closedNotes.map(note => (
                <div key={note.id} className="lt-list-item">
                  <button
                    className="lt-list-open"
                    onClick={() => openNote(note.id)}
                    disabled={openIds.length >= MAX_OPEN}
                    title={openIds.length >= MAX_OPEN ? 'Close a note to open another' : 'Open note'}
                  >
                    <span className="lt-list-title">{getTitle(note.content)}</span>
                    <span className="lt-list-date">{formatDate(note.updatedAt)}</span>
                  </button>
                  <button
                    className="lt-list-delete"
                    onClick={() => deleteNote(note.id)}
                    title="Delete note"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
