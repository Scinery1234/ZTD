import React from 'react';

/**
 * Catches render errors in the tree so a single bug does not leave a blank page.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('App error boundary:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: '#13111c',
            color: 'rgba(255,255,255,0.9)',
            fontFamily: 'Inter, system-ui, sans-serif',
            textAlign: 'center',
            maxWidth: 520,
            margin: '0 auto',
            lineHeight: 1.5,
          }}
        >
          <h1 style={{ fontSize: 20, marginBottom: 12 }}>Something went wrong</h1>
          <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: 14, marginBottom: 20 }}>
            The app hit an error. Try a hard refresh (Ctrl+Shift+R) or open the page in
            a private window. If it keeps happening, check the browser console (F12).
          </p>
          <pre
            style={{
              textAlign: 'left',
              width: '100%',
              padding: 12,
              borderRadius: 8,
              background: 'rgba(0,0,0,0.35)',
              color: '#fca5a5',
              fontSize: 12,
              overflow: 'auto',
            }}
          >
            {String(this.state.error?.message || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
