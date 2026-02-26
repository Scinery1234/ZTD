#!/bin/bash

# ZTD - Single command to start both backend and frontend
# Usage: ./run.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Starting ZTD Application..."
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down servers..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    exit
}

trap cleanup SIGINT SIGTERM

# Start Backend
echo "📦 Starting backend server..."
cd backend

# Create venv if it doesn't exist
if [ ! -d "venv" ]; then
    echo "   Creating virtual environment..."
    python3 -m venv venv
fi

# Activate venv and install dependencies
source venv/bin/activate
pip install -q -r requirements.txt 2>/dev/null || pip install -r requirements.txt

# Start backend in background
python app.py > ../backend.log 2>&1 &
BACKEND_PID=$!
cd ..

# Wait for backend to start
echo "   Waiting for backend to start..."
sleep 3

# Check if backend is running
if curl -s http://localhost:5001/api/health > /dev/null 2>&1; then
    echo "   ✅ Backend running on http://localhost:5001"
else
    echo "   ⚠️  Backend may still be starting..."
fi

echo ""

# Start Frontend
echo "🎨 Starting frontend server..."
cd frontend

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "   Installing dependencies (this may take a minute)..."
    npm install
fi

# Start frontend in background
npm start > ../frontend.log 2>&1 &
FRONTEND_PID=$!
cd ..

# Wait for frontend to start
echo "   Waiting for frontend to start..."
sleep 5

echo ""
echo "✨ ZTD is starting up!"
echo ""
echo "   Backend:  http://localhost:5001"
echo "   Frontend: http://localhost:3000"
echo ""
echo "   Logs:"
echo "   - Backend:  tail -f backend.log"
echo "   - Frontend: tail -f frontend.log"
echo ""
echo "   Press Ctrl+C to stop both servers"
echo ""

# Wait for both processes
wait $BACKEND_PID $FRONTEND_PID
