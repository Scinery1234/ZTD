import React, { useState, useEffect, useCallback } from 'react';
import './App.css';
import { AuthProvider, useAuth } from './context/AuthContext';
import { api } from './api';
import { asArray } from './utils/arrays';
import TaskList from './components/TaskList';
import TaskForm from './components/TaskForm';
import TaskFilters from './components/TaskFilters';
import Header from './components/Header';
import Stats from './components/Stats';
import HatBar from './components/HatBar';
import CategorySection from './components/CategorySection';
import TimeboxView from './components/TimeboxView';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import PricingPage from './pages/PricingPage';
import LooseThreads from './components/LooseThreads';
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
          <button
            type="button"
            className="guest-banner-btn"
            onClick={() => onSignUp()}
          >
            Create free account
          </button>
          <button
            type="button"
            className="guest-banner-btn guest-banner-btn--outline"
            onClick={() => onLogin()}
          >
            Log in
          </button>
        </div>
      </div>
      <Header onShowPricing={null} guestMode />
      <div className="app-body">
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
        <LooseThreads />
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

// ---- Categories drag-drop view ----
const CategoriesView = ({ categories, tasks, onUpdate, onDelete, onMarkDone, onAddTask, onReorderCategories }) => {
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
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
};

// ---- Main authenticated app ----
function TaskApp() {
  const { subscription, refreshSubscription } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [doneTasks, setDoneTasks] = useState([]);
  const [hats, setHats] = useState([]);
  const [selectedHatIds, setSelectedHatIds] = useState(new Set()); // empty = All
  const [filter, setFilter] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('');
  const [viewMode, setViewMode] = useState('active');
  const [dataSyncing, setDataSyncing] = useState(true);
  const [categoryOrder, setCategoryOrder] = useState([]);
  const [showPricing, setShowPricing] = useState(false);
  const [limitError, setLimitError] = useState('');

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
      const data = await api.getTasks();
      setTasks(asArray(data));
    } catch (err) {
      console.error('Error fetching tasks:', err);
    }
  }, []);

  const fetchDoneTasks = useCallback(async () => {
    try {
      const data = await api.getDoneTasks();
      setDoneTasks(asArray(data));
    } catch (err) {
      console.error('Error fetching done tasks:', err);
    }
  }, []);

  const fetchHats = async () => {
    try {
      const data = await api.getHats();
      setHats(asArray(data));
    } catch (err) {
      console.error('Error fetching hats:', err);
    }
  };

  // Load in background — shell renders immediately; banner until first sync completes
  useEffect(() => {
    setDataSyncing(true);
    void Promise.all([fetchTasks(), fetchDoneTasks(), fetchHats()])
      .catch((e) => console.error('Bootstrap fetch failed:', e))
      .finally(() => setDataSyncing(false));
  }, [fetchTasks, fetchDoneTasks]);

  const toggleHat = (hatId) => {
    if (hatId === null) {
      // "All" clicked — clear selection
      setSelectedHatIds(new Set());
      return;
    }
    setSelectedHatIds((prev) => {
      const next = new Set(prev);
      if (next.has(hatId)) {
        next.delete(hatId);
      } else {
        next.add(hatId);
      }
      return next;
    });
  };

  const addTask = async (taskData) => {
    const hat_id = selectedHatIds.size === 1 ? [...selectedHatIds][0] : null;
    try {
      setLimitError('');
      await api.addTask({ ...taskData, hat_id });
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
      await api.deleteTask(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      await refreshSubscription();
    } catch (err) {
      console.error('Error deleting task:', err);
    }
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

  const getFilteredTasks = () => {
    let filtered = tasks;
    if (selectedHatIds.size > 0)
      filtered = filtered.filter((t) => selectedHatIds.has(t.hat_id));
    if (filter === 'category' && selectedCategory)
      filtered = filtered.filter((t) => (t.category || 'Uncategorized') === selectedCategory);
    if (filter === 'priority' && selectedPriority)
      filtered = filtered.filter((t) => (t.priority || '') === selectedPriority);
    return filtered;
  };

  const getVisibleTasks = () =>
    selectedHatIds.size > 0 ? tasks.filter((t) => selectedHatIds.has(t.hat_id)) : tasks;

  const getCategories = () => {
    const all = [...new Set(getVisibleTasks().map((t) => t.category || 'Uncategorized'))];
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

  const atLimit = subscription?.at_limit;

  return (
    <div className="app">
      <Header onShowPricing={() => setShowPricing(true)} />
      <div className="app-body">
        <div className="container">
          {dataSyncing && (
            <div className="sync-banner" role="status">
              Syncing your tasks…
            </div>
          )}
          {limitError && (
            <div className="limit-banner">
              {limitError}{' '}
              <button className="limit-upgrade-btn" onClick={() => setShowPricing(true)}>Upgrade now</button>
            </div>
          )}

          {/* Hat bar */}
          <HatBar
            hats={hats}
            selectedHatIds={selectedHatIds}
            onToggleHat={toggleHat}
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
            <button className={`view-btn ${viewMode === 'timebox' ? 'active' : ''}`} onClick={() => setViewMode('timebox')}>
              Timebox
            </button>
          </div>

          {viewMode === 'active' && (
            <>
              {atLimit ? (
                <div className="limit-banner">
                  Task limit reached.{' '}
                  <button className="limit-upgrade-btn" onClick={() => setShowPricing(true)}>Upgrade to add more</button>
                </div>
              ) : (
                <TaskForm onAdd={addTask} categories={getCategories()} />
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
                onCategoryClick={(category) => {
                  setViewMode('categories');
                  setTimeout(() => {
                    const el = document.querySelector(`[data-category="${category}"]`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 100);
                }}
                viewMode="active"
              />
              <Stats tasks={getVisibleTasks()} doneTasks={doneTasks} />
              <CompletedSection doneTasks={doneTasks} />
            </>
          )}

          {viewMode === 'categories' && (
            <CategoriesView
              categories={getCategories()}
              tasks={getVisibleTasks()}
              onUpdate={updateTask}
              onDelete={deleteTask}
              onMarkDone={markDone}
              onAddTask={addTask}
              categoryOrder={categoryOrder}
              onReorderCategories={saveCategoryOrder}
            />
          )}

          {viewMode === 'timebox' && (
            <TimeboxView
              tasks={getVisibleTasks()}
              hats={hats}
              onUpdate={updateTask}
              onAddTask={addTask}
              maxHistoryDays={subscription?.tier === 'premium' ? 90 : 14}
            />
          )}
        </div>
        <LooseThreads />
      </div>
    </div>
  );
}

// URL hash so register/login/guest is bookmarkable and obvious (#register, #login, #guest)
function readAuthFromHash() {
  if (typeof window === 'undefined') {
    return { guestMode: false, authView: 'login' };
  }
  const raw = (window.location.hash || '').replace(/^#/, '').toLowerCase();
  if (raw === 'register' || raw === 'signup') {
    return { guestMode: false, authView: 'register' };
  }
  if (raw === 'guest') {
    return { guestMode: true, authView: 'login' };
  }
  return { guestMode: false, authView: 'login' };
}

// ---- Root with auth gate ----
function AppRoot() {
  const { user, loading } = useAuth();
  const { guestMode: hGuest, authView: hView } = readAuthFromHash();
  const [authView, setAuthView] = useState(hView);
  const [guestMode, setGuestMode] = useState(hGuest);

  // Keep guest/login/register in sync with #guest / #register / #login (hooks must run before any return)
  useEffect(() => {
    if (user) return;
    const onHash = () => {
      const { guestMode: g, authView: v } = readAuthFromHash();
      setGuestMode(g);
      setAuthView(v);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [user]);

  const goRegister = useCallback(() => {
    setGuestMode(false);
    setAuthView('register');
    window.location.hash = 'register';
    window.scrollTo(0, 0);
  }, []);

  const goLogin = useCallback(() => {
    setGuestMode(false);
    setAuthView('login');
    window.location.hash = 'login';
    window.scrollTo(0, 0);
  }, []);

  const goGuest = useCallback(() => {
    setGuestMode(true);
    setAuthView('login');
    window.location.hash = 'guest';
    window.scrollTo(0, 0);
  }, []);

  const onAuthViewSwitch = useCallback((view) => {
    if (view === 'register') {
      goRegister();
    } else {
      goLogin();
    }
  }, [goRegister, goLogin]);

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
          onSignUp={goRegister}
          onLogin={goLogin}
        />
      );
    }
    return authView === 'login'
      ? <LoginPage onSwitch={onAuthViewSwitch} onGuest={goGuest} onRegister={goRegister} />
      : <RegisterPage onSwitch={onAuthViewSwitch} onGuest={goGuest} />;
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
