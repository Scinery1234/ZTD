import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';
import { AuthProvider, useAuth } from './context/AuthContext';
import { api } from './api';
import TaskList from './components/TaskList';
import TaskForm from './components/TaskForm';
import TaskFilters from './components/TaskFilters';
import Header from './components/Header';
import Stats from './components/Stats';
import HatBar from './components/HatBar';
import CategorySection from './components/CategorySection';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import PricingPage from './pages/PricingPage';
import PomodoroTimer from './components/PomodoroTimer';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

// ---- Guest mode helpers (sessionStorage, cleared on tab close) ----
const GUEST_TASKS_KEY = 'ztd_guest_tasks';
const GUEST_DONE_KEY = 'ztd_guest_done';

function loadGuest(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || '[]'); } catch { return []; }
}

function saveGuest(key, data) {
  sessionStorage.setItem(key, JSON.stringify(data));
}

function parseGuestInput(input) {
  const m = input.trim().match(/^(.+?)(?:\s+@([^!~^]+))?(?:\s*!\s*(urgent|today|tomorrow|later))?(?:\s*~\s*(daily|weekly|monthly))?(?:\s*\^\s*(.+))?$/i);
  if (m) {
    return {
      description: m[1].trim(),
      category: (m[2] || '').trim(),
      priority: (m[3] || '').trim(),
      recurring: (m[4] || '').trim(),
      due: m[5] ? m[5].trim() : null,
    };
  }
  return { description: input.trim(), category: '', priority: '', recurring: '', due: null };
}

// ---- Guest Task App ----
function GuestTaskApp({ onSignUp, onLogin }) {
  const [tasks, setTasks] = useState(() => loadGuest(GUEST_TASKS_KEY));
  const [doneTasks, setDoneTasks] = useState(() => loadGuest(GUEST_DONE_KEY));
  const [filter, setFilter] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('');
  const [viewMode, setViewMode] = useState('active');

  const persist = (newTasks, newDone) => {
    if (newTasks !== undefined) { setTasks(newTasks); saveGuest(GUEST_TASKS_KEY, newTasks); }
    if (newDone !== undefined) { setDoneTasks(newDone); saveGuest(GUEST_DONE_KEY, newDone); }
  };

  const addTask = (taskData) => {
    let parsed;
    if (taskData.input) {
      parsed = parseGuestInput(taskData.input);
    } else {
      parsed = { description: taskData.description || '', category: taskData.category || '', priority: taskData.priority || '', recurring: taskData.recurring || '', due: taskData.due || null };
    }
    const newTask = { id: Date.now(), ...parsed, position: tasks.length };
    persist([...tasks, newTask], undefined);
  };

  const updateTask = (id, data) => {
    persist(tasks.map(t => t.id === id ? { ...t, ...data } : t), undefined);
  };

  const deleteTask = (id) => {
    persist(tasks.filter(t => t.id !== id), undefined);
  };

  const markDone = (id) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    const doneTask = { ...task, completed_at: new Date().toISOString() };
    persist(tasks.filter(t => t.id !== id), [...doneTasks, doneTask]);
  };

  const getFilteredTasks = () => {
    let filtered = tasks;
    if (filter === 'category' && selectedCategory)
      filtered = filtered.filter(t => (t.category || 'Uncategorized') === selectedCategory);
    if (filter === 'priority' && selectedPriority)
      filtered = filtered.filter(t => (t.priority || '') === selectedPriority);
    return filtered;
  };

  const getCategories = () => [...new Set(tasks.map(t => t.category || 'Uncategorized'))].sort();

  return (
    <div className="app">
      <div className="guest-banner">
        <span>You're in guest mode - tasks will be lost when you close this tab.</span>
        <div className="guest-banner-actions">
          <button className="guest-banner-btn" onClick={onSignUp}>Create free account</button>
          <button className="guest-banner-btn guest-banner-btn--outline" onClick={onLogin}>Log in</button>
        </div>
      </div>
      <Header onShowPricing={null} guestMode />
      <div className="container">
        <div className="view-controls">
          <button className={`view-btn ${viewMode === 'active' ? 'active' : ''}`} onClick={() => setViewMode('active')}>Active Tasks</button>
          <button className={`view-btn ${viewMode === 'done' ? 'active' : ''}`} onClick={() => setViewMode('done')}>Completed ({doneTasks.length})</button>
        </div>

        {viewMode === 'active' && (
          <>
            <TaskForm onAdd={addTask} categories={getCategories()} />
            <TaskList
              tasks={getFilteredTasks()}
              onUpdate={updateTask}
              onDelete={deleteTask}
              onMarkDone={markDone}
              onReorder={(reordered) => persist(reordered, undefined)}
              viewMode="active"
            />
            <TaskFilters
              filter={filter}
              setFilter={setFilter}
              categories={getCategories()}
              selectedCategory={selectedCategory}
              setSelectedCategory={setSelectedCategory}
              selectedPriority={selectedPriority}
              setSelectedPriority={setSelectedPriority}
            />
            <Stats tasks={tasks} doneTasks={doneTasks} />
          </>
        )}

        {viewMode === 'done' && <TaskList tasks={doneTasks} viewMode="done" />}
      </div>
    </div>
  );
}

// ---- Completed tasks collapsible section ----
function CompletedSection({ doneTasks }) {
  const [open, setOpen] = useState(false);
  if (doneTasks.length === 0) return null;
  return (
    <div className="completed-section">
      <button className="completed-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="completed-toggle-icon">{open ? '▾' : '▸'}</span>
        Completed
        <span className="completed-count">{doneTasks.length}</span>
      </button>
      {open && (
        <div className="completed-list">
          <TaskList tasks={doneTasks} viewMode="done" />
        </div>
      )}
    </div>
  );
}

// ---- Undo Toast ----
function UndoToast({ message, onUndo, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="undo-toast">
      <span>{message}</span>
      <button className="undo-toast-btn" onClick={onUndo}>Undo</button>
      <button className="undo-toast-close" onClick={onDismiss}>✕</button>
    </div>
  );
}

// ---- Categories drag-drop view ----
const CategoriesView = ({ categories, tasks, onUpdate, onDelete, onMarkDone, onAddTask, onReorderCategories, onToggleKeyTask, isPremium }) => {
  const [items, setItems] = useState(categories);

  useEffect(() => { setItems(categories); }, [categories]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((i) => `category-${i}` === active.id);
      const newIndex = items.findIndex((i) => `category-${i}` === over.id);
      const newOrder = arrayMove(items, oldIndex, newIndex);
      setItems(newOrder);
      onReorderCategories(newOrder);
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={items.map((cat) => `category-${cat}`)}
        strategy={verticalListSortingStrategy}
      >
        <div className="categories-view">
          {items.map((category) => (
            <CategorySection
              key={category}
              category={category}
              tasks={tasks.filter((t) => (t.category || 'Uncategorized') === category)}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onMarkDone={onMarkDone}
              onCategoryClick={(cat) => {
                const el = document.querySelector(`[data-category="${cat}"]`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              onAddTask={(taskData) =>
                onAddTask({ ...taskData, input: taskData.input ? `${taskData.input} @${category}`.trim() : taskData.input, category })
              }
              onToggleKeyTask={onToggleKeyTask}
              isPremium={isPremium}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
};

// ---- Key Tasks view (My Day) ----
function KeyTasksView({ tasks, onUpdate, onDelete, onMarkDone, onToggleKeyTask, isPremium }) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const keyTasks = tasks.filter((t) => t.is_key_task);
  const todayStr = new Date().toISOString().slice(0, 10);
  const dueTodayTasks = tasks.filter((t) => !t.is_key_task && t.due === todayStr);

  return (
    <div className="key-tasks-view">
      <div className="key-tasks-header">
        <h2 className="key-tasks-title">My Day</h2>
        <p className="key-tasks-date">{today}</p>
      </div>

      <div className="key-tasks-section">
        <div className="key-tasks-section-label">
          <span>★ Key Tasks</span>
          <span className="key-tasks-count">{keyTasks.length}/3</span>
        </div>
        {keyTasks.length === 0 ? (
          <p className="key-tasks-empty">
            No Key Tasks yet. Star up to 3 tasks to focus on them today.
          </p>
        ) : (
          <TaskList
            tasks={keyTasks}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onMarkDone={onMarkDone}
            onReorder={() => {}}
            onToggleKeyTask={onToggleKeyTask}
            viewMode="active"
            isPremium={isPremium}
          />
        )}
      </div>

      {dueTodayTasks.length > 0 && (
        <div className="key-tasks-section">
          <div className="key-tasks-section-label">Due today</div>
          <TaskList
            tasks={dueTodayTasks}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onMarkDone={onMarkDone}
            onReorder={() => {}}
            onToggleKeyTask={onToggleKeyTask}
            viewMode="active"
            isPremium={isPremium}
          />
        </div>
      )}
    </div>
  );
}

// ---- Trash view ----
function TrashView({ onRestored }) {
  const [trashTasks, setTrashTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchTrash = useCallback(async () => {
    try {
      const data = await api.getTrash();
      setTrashTasks(data);
    } catch (err) {
      console.error('Error fetching trash:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTrash(); }, [fetchTrash]);

  const handleRestore = async (taskId) => {
    try {
      await api.restoreTask(taskId);
      setTrashTasks((prev) => prev.filter((t) => t.id !== taskId));
      onRestored();
    } catch (err) {
      console.error('Error restoring task:', err);
    }
  };

  const handlePermanentDelete = async (taskId) => {
    if (!window.confirm('Permanently delete this task? This cannot be undone.')) return;
    try {
      await api.permanentDelete(taskId);
      setTrashTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err) {
      console.error('Error permanently deleting task:', err);
    }
  };

  const formatDeleted = (isoStr) => {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  if (loading) return <div className="key-tasks-empty">Loading trash…</div>;

  return (
    <div className="trash-view">
      <div className="trash-header">
        <h2 className="trash-title">Trash</h2>
        <p className="trash-subtitle">Tasks are automatically deleted after 30 days.</p>
      </div>
      {trashTasks.length === 0 ? (
        <p className="key-tasks-empty">Trash is empty.</p>
      ) : (
        <div className="trash-list">
          {trashTasks.map((task) => (
            <div key={task.id} className="trash-item">
              <div className="trash-item-info">
                <span className="trash-item-desc">{task.description}</span>
                {task.deleted_at && (
                  <span className="trash-item-date">Deleted {formatDeleted(task.deleted_at)}</span>
                )}
              </div>
              <div className="trash-item-actions">
                <button className="btn-restore" onClick={() => handleRestore(task.id)}>Restore</button>
                <button className="btn-perm-delete" onClick={() => handlePermanentDelete(task.id)}>Delete forever</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Main authenticated app ----
function TaskApp() {
  const { subscription, refreshSubscription } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [doneTasks, setDoneTasks] = useState([]);
  const [hats, setHats] = useState([]);
  const [currentHatId, setCurrentHatId] = useState(null); // null = All
  const [filter, setFilter] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('');
  const [viewMode, setViewMode] = useState('active');
  const [loading, setLoading] = useState(true);
  const [categoryOrder, setCategoryOrder] = useState([]);
  const [showPricing, setShowPricing] = useState(false);
  const [limitError, setLimitError] = useState('');
  const [undoToast, setUndoToast] = useState(null); // { message, taskId }

  const isPremium = subscription?.tier === 'premium';

  // Upgrade redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('upgrade') === 'success') {
      refreshSubscription();
      window.history.replaceState({}, '', '/');
    }
  }, [refreshSubscription]);

  // Load category order from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('ztd_category_order');
    if (saved) try { setCategoryOrder(JSON.parse(saved)); } catch {}
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.getTasks(currentHatId);
      setTasks(data);
    } catch (err) {
      console.error('Error fetching tasks:', err);
    }
  }, [currentHatId]);

  const fetchDoneTasks = useCallback(async () => {
    try {
      const data = await api.getDoneTasks(currentHatId);
      setDoneTasks(data);
    } catch (err) {
      console.error('Error fetching done tasks:', err);
    }
  }, [currentHatId]);

  const fetchHats = async () => {
    try {
      const data = await api.getHats();
      setHats(data);
    } catch (err) {
      console.error('Error fetching hats:', err);
    }
  };

  useEffect(() => {
    const init = async () => {
      await Promise.all([fetchTasks(), fetchDoneTasks(), fetchHats()]);
      setLoading(false);
    };
    init();
  }, []); // eslint-disable-line

  // Re-fetch tasks when hat changes
  useEffect(() => {
    fetchTasks();
    fetchDoneTasks();
  }, [fetchTasks, fetchDoneTasks]);

  const addTask = async (taskData) => {
    try {
      setLimitError('');
      await api.addTask({ ...taskData, hat_id: currentHatId });
      await fetchTasks();
      await refreshSubscription();
    } catch (err) {
      if (err.data?.upgrade_required) {
        setLimitError(err.message);
        setShowPricing(true);
      } else {
        alert(`Failed to add task: ${err.message}`);
      }
    }
  };

  const updateTask = async (taskId, taskData) => {
    try {
      await api.updateTask(taskId, taskData);
      await fetchTasks();
    } catch (err) {
      console.error('Error updating task:', err);
    }
  };

  const deleteTask = async (taskId) => {
    try {
      const result = await api.deleteTask(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      await refreshSubscription();
      // Show undo toast for premium users (soft delete)
      if (isPremium && result?.task) {
        setUndoToast({ message: `"${result.task.description}" moved to Trash`, taskId });
      }
    } catch (err) {
      console.error('Error deleting task:', err);
    }
  };

  const handleUndoDelete = async () => {
    if (!undoToast) return;
    try {
      await api.restoreTask(undoToast.taskId);
      await fetchTasks();
      await refreshSubscription();
    } catch (err) {
      console.error('Error restoring task:', err);
    }
    setUndoToast(null);
  };

  const markDone = async (taskId) => {
    try {
      await api.markDone(taskId);
      await fetchTasks();
      await fetchDoneTasks();
      await refreshSubscription();
    } catch (err) {
      console.error('Error marking task done:', err);
    }
  };

  const reorderTasks = async (reorderedTasks) => {
    try {
      await api.reorder(reorderedTasks);
      setTasks(reorderedTasks);
    } catch (err) {
      console.error('Error reordering tasks:', err);
      fetchTasks();
    }
  };

  const toggleKeyTask = async (taskId) => {
    try {
      await api.toggleKeyTask(taskId);
      await fetchTasks();
    } catch (err) {
      if (err.message) alert(err.message);
      console.error('Error toggling key task:', err);
    }
  };

  const getFilteredTasks = () => {
    let filtered = tasks;
    if (filter === 'category' && selectedCategory)
      filtered = filtered.filter((t) => (t.category || 'Uncategorized') === selectedCategory);
    if (filter === 'priority' && selectedPriority)
      filtered = filtered.filter((t) => (t.priority || '') === selectedPriority);
    return filtered;
  };

  const getCategories = () => {
    const all = [...new Set(tasks.map((t) => t.category || 'Uncategorized'))];
    if (categoryOrder.length > 0) {
      const ordered = categoryOrder.filter((c) => all.includes(c));
      const unordered = all.filter((c) => !categoryOrder.includes(c)).sort();
      return [...ordered, ...unordered];
    }
    return all.sort();
  };

  const saveCategoryOrder = (newOrder) => {
    setCategoryOrder(newOrder);
    localStorage.setItem('ztd_category_order', JSON.stringify(newOrder));
  };

  if (showPricing) return <PricingPage onBack={() => setShowPricing(false)} />;

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading your tasks…</div>
      </div>
    );
  }

  const atLimit = subscription?.at_limit;

  return (
    <div className="app">
      <Header onShowPricing={() => setShowPricing(true)} isPremium={isPremium} currentHatId={currentHatId} />
      <div className="container">
        {limitError && (
          <div className="limit-banner">
            {limitError}{' '}
            <button className="limit-upgrade-btn" onClick={() => setShowPricing(true)}>Upgrade now</button>
          </div>
        )}

        {/* Undo toast */}
        {undoToast && (
          <UndoToast
            message={undoToast.message}
            onUndo={handleUndoDelete}
            onDismiss={() => setUndoToast(null)}
          />
        )}

        {/* Hat bar */}
        <HatBar
          hats={hats}
          currentHatId={currentHatId}
          onSelectHat={(id) => { setCurrentHatId(id); }}
          onHatsChange={setHats}
        />

        {/* View tabs */}
        <div className="view-controls">
          <button className={`view-btn ${viewMode === 'active' ? 'active' : ''}`} onClick={() => setViewMode('active')}>
            Tasks
          </button>
          <button className={`view-btn ${viewMode === 'categories' ? 'active' : ''}`} onClick={() => setViewMode('categories')}>
            By Category
          </button>
          {isPremium && (
            <button className={`view-btn ${viewMode === 'keytasks' ? 'active' : ''}`} onClick={() => setViewMode('keytasks')}>
              My Day
            </button>
          )}
          {isPremium && (
            <button className={`view-btn ${viewMode === 'trash' ? 'active' : ''}`} onClick={() => setViewMode('trash')}>
              Trash
            </button>
          )}
        </div>

        {viewMode === 'active' && (
          <>
            {atLimit ? (
              <div className="limit-banner">
                Task limit reached.{' '}
                <button className="limit-upgrade-btn" onClick={() => setShowPricing(true)}>Upgrade to add more</button>
              </div>
            ) : (
              <TaskForm onAdd={addTask} categories={getCategories()} isPremium={isPremium} />
            )}
            <TaskFilters
              filter={filter}
              setFilter={setFilter}
              categories={getCategories()}
              selectedCategory={selectedCategory}
              setSelectedCategory={setSelectedCategory}
              selectedPriority={selectedPriority}
              setSelectedPriority={setSelectedPriority}
            />
            <TaskList
              tasks={getFilteredTasks()}
              onUpdate={updateTask}
              onDelete={deleteTask}
              onMarkDone={markDone}
              onReorder={reorderTasks}
              onToggleKeyTask={toggleKeyTask}
              onCategoryClick={(category) => {
                setViewMode('categories');
                setTimeout(() => {
                  const el = document.querySelector(`[data-category="${category}"]`);
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 100);
              }}
              viewMode="active"
              isPremium={isPremium}
            />
            <Stats tasks={tasks} doneTasks={doneTasks} />
            <CompletedSection doneTasks={doneTasks} />
          </>
        )}

        {viewMode === 'categories' && (
          <CategoriesView
            categories={getCategories()}
            tasks={tasks}
            onUpdate={updateTask}
            onDelete={deleteTask}
            onMarkDone={markDone}
            onAddTask={addTask}
            categoryOrder={categoryOrder}
            onReorderCategories={saveCategoryOrder}
            onToggleKeyTask={toggleKeyTask}
            isPremium={isPremium}
          />
        )}

        {viewMode === 'keytasks' && isPremium && (
          <KeyTasksView
            tasks={tasks}
            onUpdate={updateTask}
            onDelete={deleteTask}
            onMarkDone={markDone}
            onToggleKeyTask={toggleKeyTask}
            isPremium={isPremium}
          />
        )}

        {viewMode === 'trash' && isPremium && (
          <TrashView onRestored={() => { fetchTasks(); refreshSubscription(); }} />
        )}
      </div>

      {/* Pomodoro Timer (premium, floating) */}
      {isPremium && <PomodoroTimer tasks={tasks} />}
    </div>
  );
}

// ---- Root with auth gate ----
function AppRoot() {
  const { user, loading } = useAuth();
  const [authView, setAuthView] = useState('login');
  const [guestMode, setGuestMode] = useState(false);

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading…</div>
      </div>
    );
  }

  if (!user) {
    if (guestMode) {
      return (
        <GuestTaskApp
          onSignUp={() => { setGuestMode(false); setAuthView('register'); }}
          onLogin={() => { setGuestMode(false); setAuthView('login'); }}
        />
      );
    }
    return authView === 'login'
      ? <LoginPage onSwitch={setAuthView} onGuest={() => setGuestMode(true)} />
      : <RegisterPage onSwitch={setAuthView} onGuest={() => setGuestMode(true)} />;
  }

  return <TaskApp />;
}

function App() {
  return (
    <AuthProvider>
      <AppRoot />
    </AuthProvider>
  );
}

export default App;
