import React, { useState } from 'react';
import './GoalsStrip.css';

/*
 * GoalsStrip — the goal-setting framework's home in the Tasks view.
 *
 * Structure: Goal → milestones → tasks. Each goal card shows a progress bar
 * (share of milestones done) and a milestone checklist; a milestone can
 * spawn a real linked task (→ task), and completing the last open linked
 * task ticks the milestone automatically. Goals can be created here with a
 * quick form, or conversationally via the AI guide coach — both write to
 * the same /api/goals store. Check-ins (with a cadence per goal) remain the
 * coaching rhythm on top; when one is due, the card shows a badge and the
 * guide opens with a check-in.
 */

const CADENCES = [
  [1, 'Daily'],
  [7, 'Weekly'],
  [14, 'Fortnightly'],
  [30, 'Monthly'],
];

const HIDDEN_KEY = 'mh_goals_hidden';

function cadenceLabel(days) {
  const m = CADENCES.find(([d]) => d === days);
  return m ? m[1].toLowerCase() : `${days}d`;
}

function GoalForm({ hats, defaultHatId, onSave, onCancel }) {
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [hatId, setHatId] = useState(defaultHatId ?? '');
  const [targetDate, setTargetDate] = useState('');
  const [cadence, setCadence] = useState(7);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [milestones, setMilestones] = useState('');

  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave({
        title: title.trim(),
        why: why.trim(),
        hat_id: hatId === '' ? null : Number(hatId),
        target_date: targetDate.trim(),
        checkin_every_days: cadence,
        milestones: milestones.split('\n').map((s) => s.trim()).filter(Boolean),
      });
    } catch (err) {
      setError(err.message || 'Could not save the goal.');
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div className="goal-form">
      <input
        className="goal-form__title"
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What are you working toward? (e.g. Run a 10k)"
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
      />
      <input
        className="goal-form__why"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        placeholder="Why does it matter? (optional)"
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
      />
      <textarea
        className="goal-form__milestones"
        value={milestones}
        onChange={(e) => setMilestones(e.target.value)}
        placeholder={'Milestones — one per line (2–5 steps toward the goal)\ne.g. Run 2k without stopping'}
        rows={3}
      />
      <div className="goal-form__row">
        {hats && hats.length > 0 && (
          <select value={hatId} onChange={(e) => setHatId(e.target.value)} aria-label="Hat">
            <option value="">No hat</option>
            {hats.map((h) => <option key={h.id} value={h.id}>{h.emoji} {h.name}</option>)}
          </select>
        )}
        <input
          className="goal-form__date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          placeholder="Target (YYYY-MM-DD)"
        />
        <select value={cadence} onChange={(e) => setCadence(Number(e.target.value))} aria-label="Check-in rhythm">
          {CADENCES.map(([d, label]) => <option key={d} value={d}>Check in {label.toLowerCase()}</option>)}
        </select>
        <span className="goal-form__spacer" />
        <button className="goal-form__cancel" onClick={onCancel}>Cancel</button>
        <button className="goal-form__save" onClick={save} disabled={!title.trim() || saving}>
          {saving ? 'Saving…' : 'Set goal'}
        </button>
      </div>
      {error && <div className="goal-form__error">{error}</div>}
    </div>
  );
}

function GoalCard({
  goal, hat, onCheckin, onAchieve, onArchive,
  onToggleMilestone, onAddMilestone, onRemoveMilestone, onAddLinkedTask,
}) {
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [note, setNote] = useState('');
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [milestoneText, setMilestoneText] = useState('');

  const submitCheckin = async () => {
    await onCheckin(goal.id, note.trim());
    setNote('');
    setCheckinOpen(false);
  };

  const submitMilestone = async () => {
    if (!milestoneText.trim()) return;
    await onAddMilestone(goal.id, milestoneText.trim());
    setMilestoneText('');
    setAddingMilestone(false);
  };

  const progress = goal.progress || { done: 0, total: 0, pct: null };

  return (
    <div className={`goal-card${goal.checkin_due ? ' goal-card--due' : ''}`}>
      <div className="goal-card__top">
        <span className="goal-card__title" title={goal.why || undefined}>
          🎯 {goal.title}
          {progress.total > 0 && (
            <span className="goal-card__pct">{progress.done}/{progress.total}</span>
          )}
        </span>
        <span className="goal-card__actions">
          <button
            className="goal-card__btn goal-card__btn--achieve"
            title="Mark achieved"
            onClick={() => { if (window.confirm(`Mark “${goal.title}” achieved?`)) onAchieve(goal.id); }}
          >🏆</button>
          <button
            className="goal-card__btn"
            title="Archive goal"
            onClick={() => { if (window.confirm(`Archive “${goal.title}”?`)) onArchive(goal.id); }}
          >✕</button>
        </span>
      </div>

      {progress.total > 0 && (
        <div className="goal-card__bar" role="progressbar"
             aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="goal-card__bar-fill" style={{ width: `${progress.pct}%` }} />
        </div>
      )}

      <div className="goal-card__milestones">
        {(goal.milestones || []).map((m) => (
          <div key={m.id} className={`goal-ms${m.done ? ' goal-ms--done' : ''}`}>
            <label className="goal-ms__main">
              <input
                type="checkbox"
                checked={m.done}
                onChange={() => onToggleMilestone(goal.id, m)}
              />
              <span className="goal-ms__title">{m.title}</span>
            </label>
            {!m.done && (
              <button
                className="goal-ms__task"
                title="Create a task for this milestone"
                onClick={() => onAddLinkedTask(m)}
              >→ task</button>
            )}
            <button
              className="goal-ms__remove"
              title="Remove milestone"
              onClick={() => onRemoveMilestone(goal.id, m.id)}
            >✕</button>
          </div>
        ))}
        {addingMilestone ? (
          <div className="goal-ms__add-row">
            <input
              autoFocus
              value={milestoneText}
              onChange={(e) => setMilestoneText(e.target.value)}
              placeholder="Next milestone…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitMilestone();
                if (e.key === 'Escape') setAddingMilestone(false);
              }}
            />
            <button onClick={submitMilestone}>✓</button>
          </div>
        ) : (
          <button className="goal-ms__add" onClick={() => setAddingMilestone(true)}>
            + milestone
          </button>
        )}
      </div>

      <div className="goal-card__meta">
        {hat && <span className="goal-card__hat">{hat.emoji} {hat.name}</span>}
        {goal.target_date && <span className="goal-card__date">📅 {goal.target_date}</span>}
        <span className="goal-card__cadence">↻ {cadenceLabel(goal.checkin_every_days)}</span>
        {goal.checkin_due ? (
          <button className="goal-card__due-badge" onClick={() => setCheckinOpen((o) => !o)}>
            ● Check-in due
          </button>
        ) : (
          <button className="goal-card__checkin" onClick={() => setCheckinOpen((o) => !o)}>
            ✔ Check in
          </button>
        )}
      </div>
      {goal.last_checkin_note && !checkinOpen && (
        <div className="goal-card__note">“{goal.last_checkin_note}”</div>
      )}
      {checkinOpen && (
        <div className="goal-card__checkin-row">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="How's it going? (one line)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCheckin();
              if (e.key === 'Escape') setCheckinOpen(false);
            }}
          />
          <button onClick={submitCheckin}>✓</button>
        </div>
      )}
    </div>
  );
}

export default function GoalsStrip({
  goals, hats, selectedHatIds,
  onCreate, onCheckin, onAchieve, onArchive,
  onToggleMilestone, onAddMilestone, onRemoveMilestone, onAddLinkedTask,
}) {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
  });
  const [adding, setAdding] = useState(false);

  const toggleHidden = () => {
    setHidden((h) => {
      try { localStorage.setItem(HIDDEN_KEY, h ? '0' : '1'); } catch { /* ignore */ }
      return !h;
    });
  };

  const visible = (selectedHatIds && selectedHatIds.size > 0)
    ? goals.filter((g) => selectedHatIds.has(g.hat_id))
    : goals;
  const dueCount = visible.filter((g) => g.checkin_due).length;
  const hatById = {};
  (hats || []).forEach((h) => { hatById[h.id] = h; });

  const defaultHatId = (selectedHatIds && selectedHatIds.size === 1)
    ? [...selectedHatIds][0] : null;

  const openCoach = () => window.dispatchEvent(new Event('mh-open-ai-hub'));

  const create = async (data) => {
    await onCreate(data);
    setAdding(false);
  };

  return (
    <div className="goals-strip">
      <button className="goals-strip__head" onClick={toggleHidden} aria-expanded={!hidden}>
        <span className="goals-strip__title">
          🎯 Goals
          {visible.length > 0 && <span className="goals-strip__count">{visible.length}</span>}
          {dueCount > 0 && <span className="goals-strip__due">{dueCount} check-in{dueCount === 1 ? '' : 's'} due</span>}
        </span>
        <span className="goals-strip__chev">{hidden ? '▸' : '▾'}</span>
      </button>

      {!hidden && (
        <div className="goals-strip__body">
          {visible.length === 0 && !adding && (
            <div className="goals-strip__empty">
              <span>What are you working toward? Keep up to 3 goals per hat.</span>
              <span className="goals-strip__empty-actions">
                <button className="goals-strip__add" onClick={() => setAdding(true)}>+ Set a goal</button>
                <button className="goals-strip__coach" onClick={openCoach}>💬 Talk it through</button>
              </span>
            </div>
          )}

          {visible.length > 0 && (
            <div className="goals-strip__cards">
              {visible.map((g) => (
                <GoalCard
                  key={g.id}
                  goal={g}
                  hat={g.hat_id != null ? hatById[g.hat_id] : null}
                  onCheckin={onCheckin}
                  onAchieve={onAchieve}
                  onArchive={onArchive}
                  onToggleMilestone={onToggleMilestone}
                  onAddMilestone={onAddMilestone}
                  onRemoveMilestone={onRemoveMilestone}
                  onAddLinkedTask={onAddLinkedTask}
                />
              ))}
              {!adding && (
                <button className="goals-strip__add goals-strip__add--card" onClick={() => setAdding(true)}>
                  + Goal
                </button>
              )}
            </div>
          )}

          {adding && (
            <GoalForm
              hats={hats}
              defaultHatId={defaultHatId}
              onSave={create}
              onCancel={() => setAdding(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
