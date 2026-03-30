import React, { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import './HatBar.css';

const HAT_COLORS = [
  '#667eea', '#764ba2', '#f093fb', '#f5576c',
  '#4facfe', '#43e97b', '#fa709a', '#fee140',
  '#a18cd1', '#84fab0', '#fccb90', '#e0c3fc',
];

const HAT_EMOJIS = ['🎩', '💼', '🏠', '❤️', '🎓', '💪', '🌿', '🎨', '🚀', '🧘', '🤝', '⭐'];

function EmojiColorPicker({ emoji, color, onEmojiChange, onColorChange }) {
  return (
    <div className="hat-picker">
      <div className="hat-emoji-grid">
        {HAT_EMOJIS.map((e) => (
          <button
            key={e}
            className={`hat-emoji-btn ${emoji === e ? 'selected' : ''}`}
            onClick={() => onEmojiChange(e)}
            type="button"
          >
            {e}
          </button>
        ))}
      </div>
      <div className="hat-color-grid">
        {HAT_COLORS.map((c) => (
          <button
            key={c}
            className={`hat-color-btn ${color === c ? 'selected' : ''}`}
            style={{ background: c }}
            onClick={() => onColorChange(c)}
            type="button"
          />
        ))}
      </div>
    </div>
  );
}

function HatBar({ hats, selectedHatIds, onToggleHat, onHatsChange }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState('🎩');
  const [newColor, setNewColor] = useState('#667eea');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editEmoji, setEditEmoji] = useState('🎩');
  const [editColor, setEditColor] = useState('#667eea');
  const [showPickerFor, setShowPickerFor] = useState(null); // 'new' | hat_id
  const inputRef = useRef(null);
  const editInputRef = useRef(null);

  useEffect(() => {
    if (adding && inputRef.current) inputRef.current.focus();
  }, [adding]);

  useEffect(() => {
    if (editingId && editInputRef.current) editInputRef.current.focus();
  }, [editingId]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const hat = await api.createHat({ name: newName.trim(), emoji: newEmoji, color: newColor });
    onHatsChange([...hats, hat]);
    setAdding(false);
    setNewName('');
    setNewEmoji('🎩');
    setNewColor('#667eea');
    setShowPickerFor(null);
    onToggleHat(hat.id);
  };

  const handleUpdate = async (id) => {
    const hat = await api.updateHat(id, { name: editName, emoji: editEmoji, color: editColor });
    onHatsChange(hats.map((h) => (h.id === id ? hat : h)));
    setEditingId(null);
    setShowPickerFor(null);
  };

  const handleDelete = async (id) => {
    await api.deleteHat(id);
    const next = hats.filter((h) => h.id !== id);
    onHatsChange(next);
    if (selectedHatIds.has(id)) onToggleHat(id);
  };

  const startEdit = (hat) => {
    setEditingId(hat.id);
    setEditName(hat.name);
    setEditEmoji(hat.emoji);
    setEditColor(hat.color);
    setAdding(false);
  };

  return (
    <div className="hat-bar">
      {/* All tasks pill */}
      <button
        className={`hat-pill all-pill ${selectedHatIds.size === 0 ? 'active' : ''}`}
        onClick={() => onToggleHat(null)}
      >
        <span className="hat-pill-emoji">🌐</span>
        <span className="hat-pill-name">All</span>
      </button>

      {/* Hat pills */}
      {hats.map((hat) =>
        editingId === hat.id ? (
          <div key={hat.id} className="hat-edit-inline">
            <button
              className="hat-emoji-trigger"
              style={{ background: editColor + '33', borderColor: editColor + '55' }}
              onClick={() => setShowPickerFor(showPickerFor === hat.id ? null : hat.id)}
              type="button"
            >
              {editEmoji}
            </button>
            {showPickerFor === hat.id && (
              <div className="hat-picker-popup">
                <EmojiColorPicker
                  emoji={editEmoji}
                  color={editColor}
                  onEmojiChange={setEditEmoji}
                  onColorChange={setEditColor}
                />
              </div>
            )}
            <input
              ref={editInputRef}
              className="hat-edit-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleUpdate(hat.id);
                if (e.key === 'Escape') { setEditingId(null); setShowPickerFor(null); }
              }}
              style={{ borderColor: editColor + '88' }}
            />
            <button className="hat-save-btn" onClick={() => handleUpdate(hat.id)}>✓</button>
            <button className="hat-cancel-btn" onClick={() => { setEditingId(null); setShowPickerFor(null); }}>✕</button>
            <button className="hat-delete-btn" onClick={() => handleDelete(hat.id)}>🗑</button>
          </div>
        ) : (
          <button
            key={hat.id}
            className={`hat-pill ${selectedHatIds.has(hat.id) ? 'active' : ''}`}
            style={selectedHatIds.has(hat.id)
              ? { background: hat.color + '33', borderColor: hat.color + '88', color: hat.color }
              : {}}
            onClick={() => onToggleHat(hat.id)}
            onDoubleClick={() => startEdit(hat)}
            title="Double-click to rename"
          >
            <span className="hat-pill-emoji">{hat.emoji}</span>
            <span className="hat-pill-name">{hat.name}</span>
          </button>
        )
      )}

      {/* Add new hat */}
      {adding ? (
        <div className="hat-edit-inline">
          <button
            className="hat-emoji-trigger"
            style={{ background: newColor + '33', borderColor: newColor + '55' }}
            onClick={() => setShowPickerFor(showPickerFor === 'new' ? null : 'new')}
            type="button"
          >
            {newEmoji}
          </button>
          {showPickerFor === 'new' && (
            <div className="hat-picker-popup">
              <EmojiColorPicker
                emoji={newEmoji}
                color={newColor}
                onEmojiChange={setNewEmoji}
                onColorChange={setNewColor}
              />
            </div>
          )}
          <input
            ref={inputRef}
            className="hat-edit-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Workspace name…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') { setAdding(false); setShowPickerFor(null); }
            }}
            style={{ borderColor: newColor + '88' }}
          />
          <button className="hat-save-btn" onClick={handleCreate}>✓</button>
          <button className="hat-cancel-btn" onClick={() => { setAdding(false); setShowPickerFor(null); }}>✕</button>
        </div>
      ) : (
        <button className="hat-add-btn" onClick={() => setAdding(true)} title="New workspace">
          + Hat
        </button>
      )}
    </div>
  );
}

export default HatBar;
