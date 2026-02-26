#!/bin/bash

# Start the React frontend
cd "$(dirname "$0")/frontend"
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi
echo "Starting React frontend on http://localhost:3000"
npm start
