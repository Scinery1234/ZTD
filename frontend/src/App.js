import React, { useState, useEffect } from 'react';
import './App.css';
import TaskList from './components/TaskList';
import TaskForm from './components/TaskForm';
import TaskFilters from './components/TaskFilters';
import Header from './components/Header';
import Stats from './components/Stats';
import CategoryTaskAdder from './components/CategoryTaskAdder';
import CategorySection from './components/CategorySection';
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

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';

function App() {
  const [tasks, setTasks] = useState([]);
  const [doneTasks, setDoneTasks] = useState([]);
  const [filter, setFilter] = useState('all'); // all, category, priority
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('');
  const [viewMode, setViewMode] = useState('active'); // active, done, categories
  const [loading, setLoading] = useState(true);
  const [categoryOrder, setCategoryOrder] = useState([]);

  useEffect(() => {
    fetchTasks();
    fetchDoneTasks();
  }, []);

  const fetchTasks = async () => {
    try {
      const response = await fetch(`${API_URL}/tasks`);
      const data = await response.json();
      setTasks(data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      setLoading(false);
    }
  };

  const fetchDoneTasks = async () => {
    try {
      const response = await fetch(`${API_URL}/tasks/done`);
      const data = await response.json();
      setDoneTasks(data);
    } catch (error) {
      console.error('Error fetching done tasks:', error);
    }
  };

  const addTask = async (taskData) => {
    try {
      const response = await fetch(`${API_URL}/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(taskData),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }
      
      const newTask = await response.json();
      // Refresh tasks from server to ensure consistency
      await fetchTasks();
    } catch (error) {
      console.error('Error adding task:', error);
      alert(`Failed to add task: ${error.message}`);
    }
  };

  const updateTask = async (taskId, taskData) => {
    try {
      const response = await fetch(`${API_URL}/tasks/${taskId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(taskData),
      });
      const updatedTask = await response.json();
      setTasks(tasks.map((t, idx) => idx + 1 === taskId ? updatedTask : t));
    } catch (error) {
      console.error('Error updating task:', error);
    }
  };

  const deleteTask = async (taskId) => {
    try {
      await fetch(`${API_URL}/tasks/${taskId}`, {
        method: 'DELETE',
      });
      setTasks(tasks.filter((_, idx) => idx + 1 !== taskId));
    } catch (error) {
      console.error('Error deleting task:', error);
    }
  };

  const markDone = async (taskId) => {
    try {
      await fetch(`${API_URL}/tasks/${taskId}/done`, {
        method: 'POST',
      });
      fetchTasks();
      fetchDoneTasks();
    } catch (error) {
      console.error('Error marking task done:', error);
    }
  };

  const reorderTasks = async (reorderedFilteredTasks) => {
    try {
      // Get current full task list
      const currentTasks = [...tasks];
      
      // Create a map of task descriptions to find original tasks
      const taskMap = new Map();
      currentTasks.forEach((task, index) => {
        const key = `${task.description}-${task.category || ''}-${task.priority || ''}`;
        taskMap.set(key, { task, originalIndex: index });
      });
      
      // Rebuild the full tasks array in the new order
      const newTasksOrder = [];
      const usedIndices = new Set();
      
      // First, add reordered tasks in their new positions
      reorderedFilteredTasks.forEach(reorderedTask => {
        const key = `${reorderedTask.description}-${reorderedTask.category || ''}-${reorderedTask.priority || ''}`;
        if (taskMap.has(key)) {
          const { task, originalIndex } = taskMap.get(key);
          newTasksOrder.push(task);
          usedIndices.add(originalIndex);
        }
      });
      
      // Then add any remaining tasks that weren't in the filtered list
      currentTasks.forEach((task, index) => {
        if (!usedIndices.has(index)) {
          newTasksOrder.push(task);
        }
      });
      
      // Update tasks order in backend
      await fetch(`${API_URL}/tasks/reorder`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tasks: newTasksOrder }),
      });
      
      // Update local state immediately for better UX
      setTasks(newTasksOrder);
    } catch (error) {
      console.error('Error reordering tasks:', error);
      // Refresh on error to restore correct order
      fetchTasks();
    }
  };

  const getFilteredTasks = () => {
    let filtered = tasks;

    if (filter === 'category' && selectedCategory) {
      filtered = filtered.filter(task => 
        (task.category || 'Uncategorized') === selectedCategory
      );
    }

    if (filter === 'priority' && selectedPriority) {
      filtered = filtered.filter(task => 
        (task.priority || '') === selectedPriority
      );
    }

    return filtered;
  };

  const getCategories = () => {
    const categories = new Set();
    tasks.forEach(task => {
      categories.add(task.category || 'Uncategorized');
    });
    const allCategories = Array.from(categories);
    
    // If we have a saved order, use it; otherwise use alphabetical
    if (categoryOrder.length > 0) {
      const ordered = [];
      const unordered = [];
      
      // Add categories in saved order
      categoryOrder.forEach(cat => {
        if (allCategories.includes(cat)) {
          ordered.push(cat);
        }
      });
      
      // Add any new categories not in the saved order
      allCategories.forEach(cat => {
        if (!categoryOrder.includes(cat)) {
          unordered.push(cat);
        }
      });
      
      return [...ordered, ...unordered.sort()];
    }
    
    return allCategories.sort();
  };

  // Load category order from localStorage on mount
  useEffect(() => {
    const savedOrder = localStorage.getItem('ztd_category_order');
    if (savedOrder) {
      try {
        setCategoryOrder(JSON.parse(savedOrder));
      } catch (e) {
        console.error('Error loading category order:', e);
      }
    }
  }, []);

  const saveCategoryOrder = (newOrder) => {
    setCategoryOrder(newOrder);
    localStorage.setItem('ztd_category_order', JSON.stringify(newOrder));
  };

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  const CategoriesView = ({ categories, tasks, onUpdate, onDelete, onMarkDone, onAddTask, categoryOrder, onReorderCategories }) => {
    const [items, setItems] = useState(categories);

    useEffect(() => {
      setItems(categories);
    }, [categories]);

    const sensors = useSensors(
      useSensor(PointerSensor),
      useSensor(KeyboardSensor, {
        coordinateGetter: sortableKeyboardCoordinates,
      })
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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={items.map((cat) => `category-${cat}`)}
          strategy={verticalListSortingStrategy}
        >
          <div className="categories-view">
            {items.map(category => (
              <CategorySection
                key={category}
                category={category}
                tasks={tasks.filter(t => (t.category || 'Uncategorized') === category)}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onMarkDone={onMarkDone}
                onCategoryClick={(cat) => {
                  const categoryElement = document.querySelector(`[data-category="${cat}"]`);
                  if (categoryElement) {
                    categoryElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                onAddTask={(taskData) => {
                  const taskWithCategory = {
                    ...taskData,
                    input: taskData.input ? `${taskData.input} @${category}`.trim() : taskData.input,
                    category: category
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

  return (
    <div className="app">
      <Header />
      <div className="container">
        <div className="view-controls">
          <button
            className={`view-btn ${viewMode === 'active' ? 'active' : ''}`}
            onClick={() => setViewMode('active')}
          >
            Active Tasks
          </button>
          <button
            className={`view-btn ${viewMode === 'done' ? 'active' : ''}`}
            onClick={() => setViewMode('done')}
          >
            Completed ({doneTasks.length})
          </button>
          <button
            className={`view-btn ${viewMode === 'categories' ? 'active' : ''}`}
            onClick={() => setViewMode('categories')}
          >
            By Category
          </button>
        </div>

        {viewMode === 'active' && (
          <>
            <TaskForm onAdd={addTask} categories={getCategories()} />
            <TaskList
              tasks={getFilteredTasks()}
              onUpdate={updateTask}
              onDelete={deleteTask}
              onMarkDone={markDone}
              onReorder={reorderTasks}
              onCategoryClick={(category) => {
                setViewMode('categories');
                // Scroll to the category section
                setTimeout(() => {
                  const categoryElement = document.querySelector(`[data-category="${category}"]`);
                  if (categoryElement) {
                    categoryElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
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

        {viewMode === 'done' && (
          <TaskList
            tasks={doneTasks}
            viewMode="done"
          />
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
          />
        )}
      </div>
    </div>
  );
}

export default App;
