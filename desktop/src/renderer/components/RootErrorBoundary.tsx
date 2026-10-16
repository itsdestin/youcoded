import React from 'react';

/**
 * Outermost error boundary — renders without any provider context.
 * Inline styles only so it works even if CSS/themes fail to load.
 */
export class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[RootErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif',
          background: '#1a1a2e', color: '#ccc', padding: 24, textAlign: 'center',
        }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>:(</div>
          {/* Plain light words, not red (small-fixes-3#SF3-10): no status colour on words, even on
              the screen that draws before any theme loads. */}
          <div style={{ fontSize: 14, fontWeight: 600, color: '#eee' }}>
            YouCoded failed to start
          </div>
          <div style={{
            fontSize: 12, color: '#888', marginTop: 8, maxWidth: 400,
            wordBreak: 'break-word',
          }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 16, padding: '6px 16px', borderRadius: 4,
              border: '1px solid #444', background: '#2a2a3e', color: '#ccc',
              cursor: 'pointer', fontSize: 12,
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
