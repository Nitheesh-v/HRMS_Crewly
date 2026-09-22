import React from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.16 — CHUNK LOAD FAILURE BOUNDARY (§8/§9 of the CDN phase)
//
// Scenario: a user has the app open from release A; a deployment publishes
// release B and the CDN/host eventually retires A's hashed chunks. When the
// old tab lazily navigates, the old chunk request fails. Today that error is
// unhandled → white screen.
//
// This boundary catches ONLY chunk/dynamic-import load failures and shows a
// user-visible reload affordance. It NEVER reloads automatically (no loops),
// and genuine application bugs still surface exactly as before.
// ═══════════════════════════════════════════════════════════════════════════

const CHUNK_FAILURE_PATTERN =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Loading chunk \d+ failed|Loading CSS chunk \d+ failed/i;

class ChunkLoadErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { chunkFailure: false };
  }

  static getDerivedStateFromError(error) {
    const message = String(error?.message || error || '');
    if (CHUNK_FAILURE_PATTERN.test(message)) {
      return { chunkFailure: true };
    }
    // Not a static-chunk problem: leave it to the default behavior.
    return null;
  }

  componentDidCatch(error) {
    const message = String(error?.message || error || '');
    if (CHUNK_FAILURE_PATTERN.test(message)) {
      // Diagnostic only — no tokens, no PII, no auto recovery.
      console.error(
        '[Crewly] A lazy-loaded screen failed to load. A newer deployment ' +
          'likely replaced this app version while this tab was open. A manual ' +
          'reload fetches the current version.',
        error,
      );
    }
  }

  handleReload = () => {
    // User-initiated only — deliberate, bounded recovery (no auto-loop).
    window.location.reload();
  };

  render() {
    if (!this.state.chunkFailure) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        style={{
          minHeight: '60vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          padding: '24px',
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '18px' }}>This screen couldn&apos;t load</h2>
        <p style={{ margin: 0, maxWidth: '420px', color: '#555' }}>
          A newer version of Crewly may have been published while this page was
          open. Reloading will fetch the current version. Unsaved changes in
          this screen are lost.
        </p>
        <button
          type="button"
          onClick={this.handleReload}
          style={{
            padding: '8px 20px',
            borderRadius: '6px',
            border: 'none',
            background: '#2563eb',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Reload Crewly
        </button>
      </div>
    );
  }
}

export default ChunkLoadErrorBoundary;
