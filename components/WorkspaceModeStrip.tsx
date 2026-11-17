"use client";

export type WorkspaceView = 'quick' | 'advanced';

export function WorkspaceModeStrip({ mode }: { mode: WorkspaceView }) {
  const advanced = mode === 'advanced';
  return (
    <div className="vc-mode-strip">
      <span className="vc-mode-dot" aria-hidden="true" />
      <div className="vc-mode-text">
        <strong>{advanced ? 'Advanced view' : 'Quick view'}</strong>
        {' · '}
        {advanced
          ? 'Detailed registers, filters and full records; permissions stay identical.'
          : 'Clear steps and everyday tasks; all tools stay available.'}
      </div>
      <span className="vc-badge vc-badge-teal">Presentation only</span>
    </div>
  );
}
