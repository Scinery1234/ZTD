import React, { useState, useRef, useEffect, useCallback } from 'react';
import './LooseThreads.css';

const STORAGE_KEY = 'ztd_loose_threads';
const TRASH_KEY   = 'ztd_loose_threads_trash';
const MAX_OPEN    = 3;

function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function persist(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getSnippet(html) {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 38) || null;
}

function NoteEditor({ note, onUpdate, onClose }) {
  const editorRef = useRef(null);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = note.content;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const handleInput = useCallback(() => {
    if (editorRef.current) onUpdate(note.id, editorRef.current.innerHTML);
  }, [note.id, onUpdate]);

  const exec = (cmd) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, null);
  };

  return (
    <div className="lt-editor">
      <div className="lt-editor-header">
        <span className="lt-editor-date">{formatDate(note.createdAt || note.updatedAt)}</span>
        <button className="lt-close-btn" onClick={() => onClose(note.id)} title="Close">×</button>
      </div>
      <div className="lt-toolbar">
        <button className="lt-toolbar-btn" onMouseDown={e => { e.preventDefault(); exec('bold'); }} title="Bold">
          <strong>B</strong>
        </button>
        <button className="lt-toolbar-btn lt-toolbar-btn--italic" onMouseDown={e => { e.preventDefault(); exec('italic'); }} title="Italic">
          I
        </button>
        <button className="lt-toolbar-btn" onMouseDown={e => { e.preventDefault(); exec('insertUnorderedList'); }} title="Bullet list">
          •—
        </button>
        <button className="lt-toolbar-btn" onMouseDown={e => { e.preventDefault(); exec('insertOrderedList'); }} title="Numbered list">
          1.
        </button>
        <button className="lt-toolbar-btn lt-toolbar-btn--strike" onMouseDown={e => { e.preventDefault(); exec('strikeThrough'); }} title="Strikethrough">
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
  const [notes,     setNotes]     = useState(() => load(STORAGE_KEY));
  const [trash,     setTrash]     = useState(() => load(TRASH_KEY));
  const [openIds,   setOpenIds]   = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  const saveNotes = (updated) => { setNotes(updated); persist(STORAGE_KEY, updated); };
  const saveTrash = (updated) => { setTrash(updated); persist(TRASH_KEY,   updated); };

  const createNote = () => {
    const now  = Date.now();
    const note = { id: generateId(), content: '', createdAt: now, updatedAt: now };
    saveNotes([note, ...notes]);
    setOpenIds(prev => [note.id, ...prev].slice(0, MAX_OPEN));
  };

  const openNote = (id) => {
    setOpenIds(prev => prev.includes(id) ? prev : [id, ...prev].slice(0, MAX_OPEN));
  };

  const closeNote = (id) => {
    setOpenIds(prev => prev.filter(x => x !== id));
  };

  const updateNote = useCallback((id, content) => {
    setNotes(prev => {
      const updated = prev.map(n => n.id === id ? { ...n, content, updatedAt: Date.now() } : n);
      persist(STORAGE_KEY, updated);
      return updated;
    });
  }, []);

  // Move to trash instead of deleting permanently
  const trashNote = (id) => {
    const note = notes.find(n => n.id === id);
    if (!note) return;
    closeNote(id);
    saveNotes(notes.filter(n => n.id !== id));
    saveTrash([{ ...note, deletedAt: Date.now() }, ...trash]);
  };

  const restoreNote = (id) => {
    const note = trash.find(n => n.id === id);
    if (!note) return;
    const { deletedAt, ...restored } = note;
    saveTrash(trash.filter(n => n.id !== id));
    saveNotes([restored, ...notes]);
  };

  const deleteForever = (id) => {
    saveTrash(trash.filter(n => n.id !== id));
  };

  const openNotes   = openIds.map(id => notes.find(n => n.id === id)).filter(Boolean);
  const closedNotes = notes.filter(n => !openIds.includes(n.id));

  return (
    <aside className={`lt-panel${collapsed ? ' lt-panel--collapsed' : ''}`}>
      <div className="lt-panel-header">
        {!collapsed && <span className="lt-panel-title">Loose Threads</span>}
        <div className="lt-panel-actions">
          {!collapsed && (
            <button className="lt-new-btn" onClick={createNote} title="New note">+ New</button>
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
              <button className="lt-empty-btn" onClick={createNote}>Create a note</button>
            </div>
          )}

          {openNotes.length === 0 && notes.length > 0 && (
            <div className="lt-hint">Click a note to open it.</div>
          )}

          <div className="lt-editors">
            {openNotes.map(note => (
              <NoteEditor key={note.id} note={note} onUpdate={updateNote} onClose={closeNote} />
            ))}
          </div>

          {/* Saved notes list */}
          {notes.length > 0 && (
            <div className="lt-list">
              {closedNotes.length > 0 && (
                <div className="lt-list-label">Notes</div>
              )}
              {closedNotes.map(note => (
                <div key={note.id} className="lt-list-item">
                  <button
                    className="lt-list-open"
                    onClick={() => openNote(note.id)}
                    disabled={openIds.length >= MAX_OPEN}
                    title={openIds.length >= MAX_OPEN ? 'Close a note to open another' : 'Open'}
                  >
                    <span className="lt-list-date-primary">{formatDate(note.createdAt || note.updatedAt)}</span>
                    {getSnippet(note.content) && (
                      <span className="lt-list-snippet">{getSnippet(note.content)}</span>
                    )}
                  </button>
                  <button className="lt-list-delete" onClick={() => trashNote(note.id)} title="Move to trash">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Trash section */}
          {trash.length > 0 && (
            <div className="lt-trash-section">
              <button className="lt-trash-toggle" onClick={() => setTrashOpen(o => !o)}>
                <span>{trashOpen ? '▾' : '▸'}</span>
                <span>Trash</span>
                <span className="lt-trash-count">{trash.length}</span>
              </button>
              {trashOpen && (
                <div className="lt-trash-list">
                  {trash.map(note => (
                    <div key={note.id} className="lt-trash-item">
                      <div className="lt-trash-info">
                        <span className="lt-trash-date">{formatDate(note.deletedAt)}</span>
                        {getSnippet(note.content) && (
                          <span className="lt-list-snippet">{getSnippet(note.content)}</span>
                        )}
                      </div>
                      <div className="lt-trash-actions">
                        <button className="lt-trash-restore" onClick={() => restoreNote(note.id)} title="Restore">↩</button>
                        <button className="lt-trash-delete" onClick={() => deleteForever(note.id)} title="Delete forever">×</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
