import React, { useState, useEffect } from 'react';
import './App.css';
import { AuthProvider, useAuth } from './context/AuthContext';
import { api } from './api';
import TaskList from './components/TaskList';
import TaskForm from './components/TaskForm';
import TaskFilters from './components/TaskFilters';
import Header from './components/Header';
import Stats from './components/Stats';
import CategorySection from './components/CategorySection';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import PricingPage from './pages/PricingPage';
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

// ---- Categories drag-drop view (defined outside App to avoid recreation) ----
const CategoriesView = ({ categories, tasks, onUpdate, onDelete, onMarkDone, onAddTask, onReorderCategories }) => {
  const [items, setItems] = useState(categories);

  useEffect(() => {
    setItems(categories);
  }, [categories]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((item) => `category-${item}` === active.id);
      const newIndex = items.findIndex((item) => `category-${item}` === over.id);
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
              onAddTask={(taskData) => {
                const taskWithCategory = {
                  ...taskData,
                  input: taskData.input ? `${taskData.input} @${category}`.trim() : taskData.input,
                  category,
                };
                onAddTask(taskWithCategory);
              }}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
};

// ---- Main app (authenticated) ----
function TaskApp() {
  const { user, subscription, refreshSubscription } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [doneTasks, setDoneTasks] = useState([]);
  const [filter, setFilter] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('');
  const [viewMode, setViewMode] = useState('active');
  const [loading, setLoading] = useState(true);
  const [categoryOrder, setCategoryOrder] = useState([]);
  const [showPricing, setShowPricing] = useState(false);
  const [limitError, setLimitError] = useState('');

  // Show pricing page if returning from successful upgrade
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('upgrade') === 'success') {
      refreshSubscription();
      window.history.replaceState({}, '', '/');
    }
  }, [refreshSubscription]);

  useEffect(() => {
    fetchTasks();
    fetchDoneTasks();
    const savedOrder = localStorage.getItem('ztd_category_order');
    if (savedOrder) {
      try { setCategoryOrder(JSON.parse(savedOrder)); } catch {}
    }
  }, []);

  const fetchTasks = async () => {
    try {
      const data = await api.getTasks();
      setTasks(data);
    } catch (err) {
      console.error('Error fetching tasks:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchDoneTasks = async () => {
    try {
      const data = await api.getDoneTasks();
      setDoneTasks(data);
    } catch (err) {
      console.error('Error fetching done tasks:', err);
    }
  };

  const addTask = async (taskData) => {
    try {
      setLimitError('');
      await api.addTask(taskData);
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

  if (showPricing) {
    return <PricingPage onBack={() => setShowPricing(false)} />;
  }

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading your tasks...</div>
      </div>
    );
  }

  const atLimit = subscription?.at_limit;

  return (
    <div className="app">
      <Header onShowPricing={() => setShowPricing(true)} />
      <div className="container">
        {limitError && (
          <div className="limit-banner">
            {limitError}{' '}
            <button className="limit-upgrade-btn" onClick={() => setShowPricing(true)}>
              Upgrade now
            </button>
          </div>
        )}

        <div className="view-controls">
          <button className={`view-btn ${viewMode === 'active' ? 'active' : ''}`} onClick={() => setViewMode('active')}>
            Active Tasks
          </button>
          <button className={`view-btn ${viewMode === 'done' ? 'active' : ''}`} onClick={() => setViewMode('done')}>
            Completed ({doneTasks.length})
          </button>
          <button className={`view-btn ${viewMode === 'categories' ? 'active' : ''}`} onClick={() => setViewMode('categories')}>
            By Category
          </button>
        </div>

        {viewMode === 'active' && (
          <>
            {atLimit ? (
              <div className="limit-banner">
                You've reached your task limit.{' '}
                <button className="limit-upgrade-btn" onClick={() => setShowPricing(true)}>
                  Upgrade to add more
                </button>
              </div>
            ) : (
              <TaskForm onAdd={addTask} categories={getCategories()} />
            )}
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
          />
        )}
      </div>
    </div>
  );
}

// ---- Root with auth gate ----
function AppRoot() {
  const { user, loading } = useAuth();
  const [authView, setAuthView] = useState('login');

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return authView === 'login'
      ? <LoginPage onSwitch={setAuthView} />
      : <RegisterPage onSwitch={setAuthView} />;
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
