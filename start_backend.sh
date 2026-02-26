#!/bin/bash

# Start the Flask backend server
cd "$(dirname "$0")/backend"
python3 -m venv venv 2>/dev/null || true
source venv/bin/activate
pip install -q -r requirements.txt
echo "Starting Flask backend on http://localhost:5000"
python app.py
