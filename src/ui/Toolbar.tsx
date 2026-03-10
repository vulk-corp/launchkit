import { render } from 'preact';
import type { RecorderState, ToolbarPosition, RecordingResult } from '../types';
import { injectStyles, removeStyles } from './injectStyles';

interface ToolbarProps {
  position: ToolbarPosition;
  state: RecorderState;
  elapsedTime: number;
  result?: RecordingResult | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onScreenshot: () => void;
  onRestart: () => void;
}

// Icons as inline SVG for zero dependencies
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M6 6h12v12H6z" />
  </svg>
);

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const LoaderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="bw-spin">
    <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07l-2.83 2.83M9.76 14.24l-2.83 2.83m11.14 0l-2.83-2.83M9.76 9.76L6.93 6.93" />
  </svg>
);

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function Toolbar({
  position,
  state,
  elapsedTime,
  result,
  onStart,
  onPause,
  onResume,
  onStop,
  onScreenshot,
  onRestart,
}: ToolbarProps) {
  // Idle state - show compact start button
  if (state === 'idle') {
    return (
      <div
        class={`bw-recorder-toolbar ${position}`}
        data-bw-recorder-ui
      >
        <button class="bw-toolbar-idle" onClick={onStart} type="button">
          <span class="bw-idle-icon" />
          <span class="bw-idle-text">Start Recording</span>
          <span class="bw-idle-logo">bw</span>
        </button>
      </div>
    );
  }

  // Completed state
  if (state === 'stopped' && result) {
    return (
      <div
        class={`bw-recorder-toolbar ${position}`}
        data-bw-recorder-ui
      >
        <div class="bw-toolbar-complete">
          <span class="bw-complete-icon">
            <CheckIcon />
          </span>
          <span class="bw-complete-text">
            Recording saved!{' '}
            <a href={result.playbackUrl} target="_blank" rel="noopener noreferrer">
              View
            </a>
          </span>
          <button class="bw-restart-btn" onClick={onRestart} type="button" title="Start new recording">
            New
          </button>
        </div>
      </div>
    );
  }

  // Saving state (stopped but no result yet)
  if (state === 'stopped') {
    return (
      <div
        class={`bw-recorder-toolbar ${position}`}
        data-bw-recorder-ui
      >
        <div class="bw-toolbar-complete">
          <span class="bw-complete-icon bw-saving">
            <LoaderIcon />
          </span>
          <span class="bw-complete-text">Saving...</span>
        </div>
      </div>
    );
  }

  // Recording/Paused state - full toolbar
  const isRecording = state === 'recording';
  const isPaused = state === 'paused';

  return (
    <div
      class={`bw-recorder-toolbar ${position}`}
      data-bw-recorder-ui
    >
      <div class="bw-toolbar-container">
        {/* Status */}
        <div class="bw-toolbar-status">
          <span
            class={`bw-status-indicator ${isRecording ? 'recording' : ''} ${isPaused ? 'paused' : ''}`}
          />
          <span class="bw-status-text">
            {isRecording ? 'Recording' : 'Paused'}
          </span>
          <span class="bw-status-time">{formatTime(elapsedTime)}</span>
        </div>

        {/* Pause/Resume */}
        <button
          class="bw-toolbar-btn"
          onClick={isRecording ? onPause : onResume}
          title={isRecording ? 'Pause' : 'Resume'}
          type="button"
        >
          {isRecording ? <PauseIcon /> : <PlayIcon />}
        </button>

        {/* Stop */}
        <button
          class="bw-toolbar-btn stop"
          onClick={onStop}
          title="Stop Recording"
          type="button"
        >
          <StopIcon />
        </button>

        <div class="bw-toolbar-divider" />

        {/* Screenshot */}
        <button
          class="bw-toolbar-btn"
          onClick={onScreenshot}
          title="Take Screenshot"
          disabled={!isRecording}
          type="button"
        >
          <CameraIcon />
        </button>

        <div class="bw-toolbar-divider" />

        {/* Logo */}
        <span class="bw-toolbar-logo">bw</span>
      </div>
    </div>
  );
}

/**
 * Toolbar controller for managing the Preact component lifecycle
 */
export class ToolbarController {
  private container: HTMLDivElement | null = null;
  private position: ToolbarPosition;
  private state: RecorderState = 'idle';
  private elapsedTime: number = 0;
  private result: RecordingResult | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private getElapsedTime: (() => number) | null = null;

  // Callbacks
  private onStartCallback: (() => void) | null = null;
  private onPauseCallback: (() => void) | null = null;
  private onResumeCallback: (() => void) | null = null;
  private onStopCallback: (() => void) | null = null;
  private onScreenshotCallback: (() => void) | null = null;
  private onRestartCallback: (() => void) | null = null;

  constructor(position: ToolbarPosition = 'bottom-right') {
    this.position = position;
  }

  /**
   * Mount the toolbar to the DOM
   */
  mount(): void {
    if (this.container) return;

    // Inject styles first
    injectStyles();

    this.container = document.createElement('div');
    this.container.id = 'bw-recorder-root';
    this.container.setAttribute('data-bw-recorder-ui', '');
    document.body.appendChild(this.container);

    this.render();
  }

  /**
   * Unmount the toolbar from the DOM
   */
  unmount(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.container) {
      render(null, this.container);
      this.container.remove();
      this.container = null;
    }

    // Clean up styles
    removeStyles();
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: {
    onStart?: () => void;
    onPause?: () => void;
    onResume?: () => void;
    onStop?: () => void;
    onScreenshot?: () => void;
    onRestart?: () => void;
    getElapsedTime?: () => number;
  }): void {
    this.onStartCallback = callbacks.onStart ?? null;
    this.onPauseCallback = callbacks.onPause ?? null;
    this.onResumeCallback = callbacks.onResume ?? null;
    this.onStopCallback = callbacks.onStop ?? null;
    this.onScreenshotCallback = callbacks.onScreenshot ?? null;
    this.onRestartCallback = callbacks.onRestart ?? null;
    this.getElapsedTime = callbacks.getElapsedTime ?? null;
  }

  /**
   * Update state
   */
  setState(state: RecorderState): void {
    this.state = state;

    // Start/stop timer updates
    if (state === 'recording') {
      this.startTimeUpdates();
    } else if (state === 'stopped' || state === 'idle') {
      this.stopTimeUpdates();
    }

    this.render();
  }

  /**
   * Set recording result
   */
  setResult(result: RecordingResult): void {
    this.result = result;
    this.render();
  }

  /**
   * Reset to idle state (for restart)
   */
  reset(): void {
    this.state = 'idle';
    this.result = null;
    this.elapsedTime = 0;
    this.render();
  }

  /**
   * Start time updates
   */
  private startTimeUpdates(): void {
    if (this.updateInterval) return;

    this.updateInterval = setInterval(() => {
      if (this.getElapsedTime) {
        this.elapsedTime = this.getElapsedTime();
        this.render();
      }
    }, 100);
  }

  /**
   * Stop time updates
   */
  private stopTimeUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Render the toolbar
   */
  private render(): void {
    if (!this.container) return;

    render(
      <Toolbar
        position={this.position}
        state={this.state}
        elapsedTime={this.elapsedTime}
        result={this.result}
        onStart={() => this.onStartCallback?.()}
        onPause={() => this.onPauseCallback?.()}
        onResume={() => this.onResumeCallback?.()}
        onStop={() => this.onStopCallback?.()}
        onScreenshot={() => this.onScreenshotCallback?.()}
        onRestart={() => this.onRestartCallback?.()}
      />,
      this.container
    );
  }
}
