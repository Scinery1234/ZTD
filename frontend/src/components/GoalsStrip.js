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
          type="date"
          className="goal-form__date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          title="Target date (optional)"
          aria-label="Target date (optional)"
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
  onRenameGoal, onRenameMilestone, onMilestoneDue, onReorderMilestones,
  tasks,
}) {
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [note, setNote] = useState('');
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [milestoneText, setMilestoneText] = useState('');

  // Inline rename of the goal title and of individual milestones.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState(goal.title);
  const [editingMsId, setEditingMsId] = useState(null);
  const [msText, setMsText] = useState('');

  const startTitleEdit = () => { setTitleText(goal.title); setEditingTitle(true); };
  const commitTitle = async () => {
    const t = titleText.trim();
    setEditingTitle(false);
    if (t && t !== goal.title && onRenameGoal) await onRenameGoal(goal.id, t);
  };
  const startMsEdit = (m) => { setMsText(m.title); setEditingMsId(m.id); };
  const commitMs = async (m) => {
    const t = msText.trim();
    setEditingMsId(null);
    if (t && t !== m.title && onRenameMilestone) await onRenameMilestone(goal.id, m.id, t);
  };

  // Optional milestone due dates, reordering, and the per-milestone task panel.
  const [dueEditId, setDueEditId] = useState(null);
  const [openTasksId, setOpenTasksId] = useState(null);
  const [taskText, setTaskText] = useState('');

  const milestones = goal.milestones || [];
  const openMs = milestones.find((m) => m.id === openTasksId) || null;

  // Real tasks already linked to each milestone, from the live task list.
  const tasksByMilestone = {};
  (tasks || []).forEach((t) => {
    if (t.milestone_id != null) {
      (tasksByMilestone[t.milestone_id] = tasksByMilestone[t.milestone_id] || []).push(t);
    }
  });

  const move = (idx, delta) => {
    const next = [...milestones];
    const to = idx + delta;
    if (to < 0 || to >= next.length) return;
    [next[idx], next[to]] = [next[to], next[idx]];
    if (onReorderMilestones) onReorderMilestones(goal.id, next.map((m) => m.id));
  };

  const submitLinkedTask = async () => {
    const text = taskText.trim();
    if (!openMs) return;
    await onAddLinkedTask(openMs, goal, text || openMs.title);
    setTaskText('');
  };

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
          🎯{' '}
          {editingTitle ? (
            <input
              className="goal-card__title-input"
              autoFocus
              value={titleText}
              onChange={(e) => setTitleText(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
            />
          ) : (
            <span
              className="goal-card__title-text"
              role="button"
              title="Click to rename"
              onClick={startTitleEdit}
            >{goal.title}</span>
          )}
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
        {milestones.map((m, i) => (
          <div key={m.id} className={`goal-ms${m.done ? ' goal-ms--done' : ''}`}>
            <span className="goal-ms__order">
              <button
                className="goal-ms__move"
                title="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >▴</button>
              <button
                className="goal-ms__move"
                title="Move down"
                disabled={i === milestones.length - 1}
                onClick={() => move(i, 1)}
              >▾</button>
            </span>
            <label className="goal-ms__main">
              <input
                type="checkbox"
                checked={m.done}
                onChange={() => onToggleMilestone(goal.id, m)}
              />
              {editingMsId === m.id ? (
                <input
                  className="goal-ms__title-input"
                  autoFocus
                  value={msText}
                  onChange={(e) => setMsText(e.target.value)}
                  onBlur={() => commitMs(m)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitMs(m);
                    if (e.key === 'Escape') setEditingMsId(null);
                  }}
                />
              ) : (
                <span
                  className="goal-ms__title"
                  title="Click to rename"
                  onClick={(e) => { e.preventDefault(); startMsEdit(m); }}
                >{m.title}</span>
              )}
            </label>
            {/* Optional target date — empty until you set one */}
            {onMilestoneDue && (
              dueEditId === m.id ? (
                <input
                  type="date"
                  className="goal-ms__due-input"
                  autoFocus
                  defaultValue={m.due || ''}
                  onBlur={(e) => { onMilestoneDue(goal.id, m.id, e.target.value); setDueEditId(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { onMilestoneDue(goal.id, m.id, e.target.value); setDueEditId(null); }
                    if (e.key === 'Escape') setDueEditId(null);
                  }}
                />
              ) : (
                <button
                  className={`goal-ms__due${m.due ? ' goal-ms__due--set' : ''}`}
                  title={m.due ? `Due ${m.due} — click to change` : 'Set an optional due date'}
                  onClick={() => setDueEditId(m.id)}
                >{m.due ? `📅 ${m.due.slice(5)}` : '📅'}</button>
              )
            )}
            <button
              className={`goal-ms__tasks-btn${openTasksId === m.id ? ' is-open' : ''}`}
              title="Tasks for this milestone"
              onClick={() => setOpenTasksId((id) => (id === m.id ? null : m.id))}
            >☰ {(tasksByMilestone[m.id] || []).length || ''}</button>
            <button
              className="goal-ms__remove"
              title="Remove milestone"
              onClick={() => onRemoveMilestone(goal.id, m.id)}
            >✕</button>
          </div>
        ))}
        {/* Task panel for the open milestone: its real tasks, and a box to add
            more. Tasks land in the normal task list, tagged with the goal. */}
        {openMs && (
          <div className="goal-ms-tasks">
            <div className="goal-ms-tasks__hd">
              Tasks for “{openMs.title}”
              <span className="goal-ms-tasks__tag">{goal.title}</span>
            </div>
            {(tasksByMilestone[openMs.id] || []).length === 0 ? (
              <div className="goal-ms-tasks__empty">No tasks yet — add the first step.</div>
            ) : (
              (tasksByMilestone[openMs.id] || []).map((t) => (
                <div key={t.id} className="goal-ms-tasks__row">
                  <span className="goal-ms-tasks__dot" />
                  <span className="goal-ms-tasks__desc">{t.description}</span>
                  {t.due && <span className="goal-ms-tasks__due">{t.due.slice(5)}</span>}
                </div>
              ))
            )}
            <div className="goal-ms__add-row">
              <input
                value={taskText}
                onChange={(e) => setTaskText(e.target.value)}
                placeholder="Add a task for this milestone…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitLinkedTask();
                  if (e.key === 'Escape') setOpenTasksId(null);
                }}
              />
              <button onClick={submitLinkedTask}>+</button>
            </div>
          </div>
        )}
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
  onRenameGoal, onRenameMilestone, onMilestoneDue, onReorderMilestones,
  onFetchPastGoals, onRestoreGoal, onDeleteGoal, tasks,
}) {
  const [pastOpen, setPastOpen] = useState(false);
  const [pastGoals, setPastGoals] = useState(null);   // null = not loaded yet

  const togglePast = async () => {
    const next = !pastOpen;
    setPastOpen(next);
    if (next && onFetchPastGoals) setPastGoals(await onFetchPastGoals());
  };

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
                  onRenameGoal={onRenameGoal}
                  onRenameMilestone={onRenameMilestone}
                  onMilestoneDue={onMilestoneDue}
                  onReorderMilestones={onReorderMilestones}
                  tasks={tasks}
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

          {/* Achieved & archived goals — loaded on demand */}
          {onFetchPastGoals && (
            <div className="goals-past">
              <button className="goals-past__toggle" onClick={togglePast}>
                {pastOpen ? '▾' : '▸'} Achieved &amp; archived
              </button>
              {pastOpen && (
                pastGoals === null ? (
                  <div className="goals-past__empty">Loading…</div>
                ) : pastGoals.length === 0 ? (
                  <div className="goals-past__empty">Nothing here yet — finished goals land here.</div>
                ) : (
                  <div className="goals-past__list">
                    {pastGoals.map((g) => (
                      <div key={g.id} className="goals-past__row">
                        <span className="goals-past__icon">{g.status === 'achieved' ? '🏆' : '📦'}</span>
                        <span className="goals-past__title">{g.title}</span>
                        <span className="goals-past__status">{g.status}</span>
                        {onRestoreGoal && (
                          <button
                            className="goals-past__btn"
                            title="Make this an active goal again"
                            onClick={async () => { await onRestoreGoal(g.id); setPastGoals(await onFetchPastGoals()); }}
                          >↺ Restore</button>
                        )}
                        {onDeleteGoal && (
                          <button
                            className="goals-past__btn goals-past__btn--del"
                            title="Delete permanently"
                            onClick={async () => {
                              if (!window.confirm(`Delete “${g.title}” for good? This can't be undone.`)) return;
                              await onDeleteGoal(g.id);
                              setPastGoals(await onFetchPastGoals());
                            }}
                          >🗑</button>
                        )}
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
