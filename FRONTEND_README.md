# ZTD Frontend - Web Application

A modern, beautiful web interface for the ZTD (Zen To Done) Task Manager.

## Features

- ✨ Modern, responsive UI with gradient design
- 📊 Real-time statistics dashboard
- ✅ Add, edit, delete, and mark tasks as done
- 🏷️ Category and priority filtering
- 📅 Due date tracking with natural language parsing
- 🔄 Recurring task support
- 📱 Mobile-responsive design
- 🎨 Beautiful color-coded priorities and categories

## Architecture

The frontend consists of:
- **Backend**: Flask REST API (`backend/app.py`)
- **Frontend**: React application (`frontend/`)

## Setup Instructions

### Prerequisites

- Python 3.10+
- Node.js 16+ and npm

### Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Create a virtual environment (recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate  # macOS/Linux
   venv\Scripts\activate     # Windows
   ```

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Run the Flask server:
   ```bash
   python app.py
   ```

   The API will be available at `http://localhost:5000`

### Frontend Setup

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm start
   ```

   The app will open at `http://localhost:3000`

## Usage

1. **Start the backend** (in one terminal):
   ```bash
   cd backend
   python app.py
   ```

2. **Start the frontend** (in another terminal):
   ```bash
   cd frontend
   npm start
   ```

3. Open your browser to `http://localhost:3000`

## API Endpoints

- `GET /api/tasks` - Get all active tasks
- `POST /api/tasks` - Add a new task
- `PUT /api/tasks/<id>` - Update a task
- `DELETE /api/tasks/<id>` - Delete a task
- `POST /api/tasks/<id>/done` - Mark task as done
- `GET /api/tasks/done` - Get completed tasks
- `GET /api/tasks/categories` - Get tasks grouped by category
- `GET /api/health` - Health check

## Project Structure

```
ZTD/
├── backend/
│   ├── app.py              # Flask API server
│   └── requirements.txt    # Python dependencies
├── frontend/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── components/     # React components
│   │   │   ├── Header.js
│   │   │   ├── Stats.js
│   │   │   ├── TaskForm.js
│   │   │   ├── TaskList.js
│   │   │   ├── TaskItem.js
│   │   │   └── TaskFilters.js
│   │   ├── App.js          # Main app component
│   │   ├── App.css
│   │   ├── index.js
│   │   └── index.css
│   └── package.json
├── tasks.json              # Task storage (shared with CLI)
├── done_tasks.json         # Completed tasks (shared with CLI)
└── ZTD_APP_Code.py         # Original CLI application
```

## Features in Detail

### Task Management
- Add tasks with description, category, priority, recurrence, and due date
- Edit tasks inline
- Delete tasks
- Mark tasks as done (moves to completed list)

### Views
- **Active Tasks**: View and manage current tasks
- **Completed**: View completed tasks
- **By Category**: Group tasks by category

### Filtering
- Filter by category
- Filter by priority (urgent, today, tomorrow, later)

### Statistics
- Active task count
- Urgent tasks
- Tasks due today
- Overdue tasks
- Completed tasks

## Styling

The frontend uses:
- Modern CSS with flexbox and grid
- Gradient backgrounds
- Smooth animations and transitions
- Responsive design for mobile devices
- Color-coded priorities and categories

## Development

### Building for Production

```bash
cd frontend
npm run build
```

This creates an optimized production build in the `build/` directory.

## Notes

- The frontend and CLI share the same JSON files (`tasks.json` and `done_tasks.json`)
- Changes made in the web app will be reflected in the CLI and vice versa
- The backend runs on port 5000 by default
- The frontend runs on port 3000 by default
