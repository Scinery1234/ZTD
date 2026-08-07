import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { initNativeShell } from './native';

// No-op on the web; sets up status bar, splash and safe areas in the iOS shell.
initNativeShell();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
