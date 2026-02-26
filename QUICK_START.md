# Quick Start Guide - ZTD Web Frontend

## 🚀 Quick Start (Single Command!)

### macOS/Linux
```bash
./run.sh
```

### Windows
```batch
run.bat
```

That's it! The script will:
- ✅ Start the backend server on http://localhost:5001
- ✅ Start the frontend server on http://localhost:3000
- ✅ Automatically install dependencies if needed
- ✅ Open your browser to the app

**Press Ctrl+C to stop both servers**

---

### Manual Start (Alternative)

If you prefer to run them separately:

#### Terminal 1 - Backend
```bash
cd backend
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

#### Terminal 2 - Frontend
```bash
cd frontend
npm install
npm start
```

Then open **http://localhost:3000** in your browser!

## 📋 What You Get

- ✅ Beautiful, modern web interface
- 📊 Real-time statistics dashboard
- 🎯 Task management (add, edit, delete, complete)
- 🏷️ Categories and priorities
- 📅 Due dates with natural language parsing
- 🔄 Recurring tasks
- 📱 Fully responsive design

## 🎨 Features

### Views
- **Active Tasks**: Manage your current tasks
- **Completed**: View your completed tasks
- **By Category**: See tasks organized by category

### Task Properties
- **Description**: What needs to be done
- **Category**: Organize with @category tags
- **Priority**: urgent, today, tomorrow, later
- **Recurring**: daily, weekly, monthly
- **Due Date**: Natural language (e.g., "tomorrow", "next Friday")

### Statistics
- Active task count
- Urgent tasks
- Tasks due today
- Overdue tasks
- Completed tasks

## 💡 Tips

1. **Quick Add**: Just type the task description and click "Add Task"
2. **Advanced Options**: Click "Advanced Options" to add category, priority, recurrence, and due date
3. **Edit Tasks**: Click the ✏️ icon on any task to edit it
4. **Filter**: Use the filter dropdown to view tasks by category or priority
5. **Views**: Switch between Active, Completed, and Category views using the buttons at the top

## 🔧 Troubleshooting

### Backend won't start
- Make sure Python 3.10+ is installed
- Check that all dependencies are installed: `pip install -r requirements.txt`
- Ensure port 5001 is not in use (macOS AirPlay uses 5000, so we use 5001)

### Frontend won't start
- Make sure Node.js 16+ is installed
- Run `npm install` in the frontend directory
- Check that port 3000 is not in use

### Tasks not showing
- Make sure the backend is running on port 5001
- Check browser console for errors
- Verify `tasks.json` exists in the project root
- Make sure both servers started successfully (check the logs)

## 📁 File Structure

```
ZTD/
├── backend/
│   ├── app.py              # Flask API
│   └── requirements.txt
├── frontend/
│   ├── src/               # React source code
│   └── package.json
├── tasks.json             # Task storage (shared)
├── done_tasks.json        # Completed tasks (shared)
└── ZTD_APP_Code.py        # Original CLI app
```

The web app and CLI share the same task files, so you can use either interface!
