from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import json
import re
from datetime import datetime
import dateparser

app = Flask(__name__)
CORS(app)  # Enable CORS for React frontend

TASKS_FILE = "tasks.json"
DONE_FILE = "done_tasks.json"

# Ensure we're in the right directory
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS_FILE_PATH = os.path.join(BASE_DIR, TASKS_FILE)
DONE_FILE_PATH = os.path.join(BASE_DIR, DONE_FILE)

def load_tasks():
    """Load tasks from JSON files"""
    try:
        with open(TASKS_FILE_PATH, "r") as f:
            tasks = json.load(f)
    except:
        tasks = []
    
    try:
        with open(DONE_FILE_PATH, "r") as f:
            completed_tasks = json.load(f)
    except:
        completed_tasks = []
    
    return tasks, completed_tasks

def save_tasks(tasks, completed_tasks):
    """Save tasks to JSON files"""
    with open(TASKS_FILE_PATH, "w") as f:
        json.dump(tasks, f, indent=2)
    with open(DONE_FILE_PATH, "w") as f:
        json.dump(completed_tasks, f, indent=2)

@app.route('/api/tasks', methods=['GET'])
def get_tasks():
    """Get all active tasks"""
    tasks, _ = load_tasks()
    return jsonify(tasks)

@app.route('/api/tasks', methods=['POST'])
def add_task():
    """Add a new task"""
    try:
        data = request.json
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        tasks, completed_tasks = load_tasks()
        
        # Parse task input similar to CLI version
        input_str = data.get('input', '').strip()
        if not input_str:
            # Direct task creation
            description = data.get('description', '').strip()
            if not description:
                return jsonify({'error': 'Task description is required'}), 400
            
            task = {
                'description': description,
                'category': data.get('category', '').strip(),
                'priority': data.get('priority', '').strip(),
                'recurring': data.get('recurring', '').strip(),
                'due': data.get('due', '').strip() or None
            }
            tasks.append(task)
            save_tasks(tasks, completed_tasks)
            return jsonify(task), 201
        
        # Parse natural language input (same pattern as CLI)
        # Handle multiple tasks separated by commas
        tasks_raw = [t.strip() for t in input_str.split(",") if t.strip()]
        if not tasks_raw:
            return jsonify({'error': 'Invalid task input'}), 400
        
        all_tasks = []
        
        for task_raw in tasks_raw:
            pattern = r"(?P<desc>.+?)(?:\s+@(?P<cat>[^!~^]+))?(?:\s*!\s*(?P<prio>urgent|today|tomorrow|later))?(?:\s*~\s*(?P<recur>daily|weekly|monthly))?(?:\s*\^\s*(?P<due>.+))?$"
            match = re.match(pattern, task_raw.strip(), re.IGNORECASE)
            
            if match:
                desc = match.group("desc").strip()
                cat = (match.group("cat") or "").strip()
                prio = (match.group("prio") or "").strip()
                recur = (match.group("recur") or "").strip()
                due_text = (match.group("due") or "").strip()
            else:
                desc = task_raw.strip()
                cat = ""
                prio = ""
                recur = ""
                due_text = ""
            
            if not desc:
                continue  # Skip empty tasks
            
            due = None
            if due_text:
                parsed = dateparser.parse(due_text)
                if parsed:
                    due = parsed.strftime("%Y-%m-%d")
            
            task = {
                'description': desc,
                'category': cat,
                'priority': prio,
                'recurring': recur,
                'due': due
            }
            all_tasks.append(task)
            tasks.append(task)
        
        if not all_tasks:
            return jsonify({'error': 'No valid tasks to add'}), 400
        
        save_tasks(tasks, completed_tasks)
        
        # Return the last task added (for single task, it's the only one)
        return jsonify(all_tasks[-1]), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    

@app.route('/api/tasks/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    """Update a task"""
    tasks, completed_tasks = load_tasks()
    
    if task_id < 1 or task_id > len(tasks):
        return jsonify({'error': 'Task not found'}), 404
    
    data = request.json
    task = tasks[task_id - 1]
    
    if 'description' in data:
        task['description'] = data['description']
    if 'category' in data:
        task['category'] = data.get('category', '')
    if 'priority' in data:
        task['priority'] = data.get('priority', '')
    if 'recurring' in data:
        task['recurring'] = data.get('recurring', '')
    if 'due' in data:
        due_text = data.get('due', '')
        if due_text:
            parsed = dateparser.parse(due_text)
            if parsed:
                task['due'] = parsed.strftime("%Y-%m-%d")
            else:
                task['due'] = due_text
        else:
            task['due'] = None
    
    save_tasks(tasks, completed_tasks)
    return jsonify(task)

@app.route('/api/tasks/<int:task_id>', methods=['DELETE'])
def delete_task(task_id):
    """Delete a task"""
    tasks, completed_tasks = load_tasks()
    
    if task_id < 1 or task_id > len(tasks):
        return jsonify({'error': 'Task not found'}), 404
    
    removed_task = tasks.pop(task_id - 1)
    save_tasks(tasks, completed_tasks)
    return jsonify({'message': 'Task deleted', 'task': removed_task})

@app.route('/api/tasks/<int:task_id>/done', methods=['POST'])
def mark_task_done(task_id):
    """Mark a task as done"""
    tasks, completed_tasks = load_tasks()
    
    if task_id < 1 or task_id > len(tasks):
        return jsonify({'error': 'Task not found'}), 404
    
    task = tasks.pop(task_id - 1)
    if task.get("recurring"):
        task["last_done"] = datetime.today().strftime("%Y-%m-%d")
    
    completed_tasks.append(task)
    save_tasks(tasks, completed_tasks)
    return jsonify(task)

@app.route('/api/tasks/done', methods=['GET'])
def get_done_tasks():
    """Get all completed tasks"""
    _, completed_tasks = load_tasks()
    return jsonify(completed_tasks)

@app.route('/api/tasks/categories', methods=['GET'])
def get_tasks_by_category():
    """Get tasks grouped by category"""
    tasks, _ = load_tasks()
    from collections import defaultdict
    grouped = defaultdict(list)
    
    for task in tasks:
        category = task.get("category", "").strip() or "Uncategorized"
        grouped[category].append(task)
    
    return jsonify(dict(grouped))

@app.route('/api/tasks/reorder', methods=['POST'])
def reorder_tasks():
    """Reorder tasks"""
    try:
        data = request.json
        new_tasks = data.get('tasks', [])
        
        if not new_tasks:
            return jsonify({'error': 'No tasks provided'}), 400
        
        tasks, completed_tasks = load_tasks()
        
        # Replace tasks with new order
        tasks = new_tasks
        save_tasks(tasks, completed_tasks)
        
        return jsonify({'message': 'Tasks reordered successfully', 'tasks': tasks}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    app.run(debug=True, port=5001)
