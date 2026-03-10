import { Recorder } from './recorder';
import { ScreenshotCapture } from './screenshot';
import { EventDetector } from './events';
import { MockUploader, ApiUploader } from './uploader';
import { ToolbarController } from './ui/Toolbar';
import { InviteDialogController } from './ui/InviteDialog';
import { configureSender } from './telemetry-sender';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { startErrorCapture, stopErrorCapture } from './error-capture';
import type { RecorderConfig, RecorderState, RecordingResult, LaunchKitConfig } from './types';

// Export InviteDialogController for programmatic use
export { InviteDialogController };

// Re-export types
export type {
  RecorderConfig,
  RecorderState,
  RecordingResult,
  LaunchKitConfig,
  ToolbarPosition,
  ScreenshotMarker,
  ScreenshotEventType,
} from './types';

/**
 * Main DemoRecorder class - orchestrates all components
 */
export class DemoRecorder {
  private config: RecorderConfig;
  private recorder: Recorder;
  private screenshotMarker: ScreenshotCapture;
  private eventDetector: EventDetector;
  private toolbar: ToolbarController | null = null;
  private isInitialized: boolean = false;

  constructor(config: RecorderConfig) {
    // Set up state change handling wrapper before creating recorder
    const originalOnStateChange = config.onStateChange;

    this.config = {
      apiEndpoint: 'https://api.bworlds.com',
      maxDuration: 15 * 60 * 1000,
      maskInputs: true,
      autoOpenPlayback: true,
      toolbar: {
        enabled: true,
        position: 'bottom-right',
      },
      ...config,
      onStateChange: (state) => {
        this.handleStateChange(state);
        originalOnStateChange?.(state);
      },
    };

    // Initialize components
    this.recorder = new Recorder(this.config);
    this.screenshotMarker = new ScreenshotCapture();
    this.eventDetector = new EventDetector(this.screenshotMarker);

    // Set up uploader - use real API if endpoint is configured, otherwise mock
    const useRealApi = this.config.apiEndpoint && this.config.apiEndpoint !== 'https://api.bworlds.com';
    const uploader = useRealApi
      ? new ApiUploader(this.config.apiEndpoint!, this.config.apiKey)
      : new MockUploader();
    this.recorder.setUploader(uploader);

    // Wire up recorder events to event detector
    this.recorder.onEvent((event) => {
      this.eventDetector.handleRrwebEvent(event);
    });
  }

  /**
   * Initialize the recorder (mount toolbar)
   */
  init(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Mount toolbar if enabled
    if (this.config.toolbar?.enabled !== false) {
      const position = this.config.toolbar?.position ?? 'bottom-right';
      this.toolbar = new ToolbarController(position);

      this.toolbar.setCallbacks({
        onStart: () => this.start(),
        onPause: () => this.pause(),
        onResume: () => this.resume(),
        onStop: () => this.stop(),
        onScreenshot: () => this.screenshot(),
        onRestart: () => this.restart(),
        getElapsedTime: () => this.recorder.getElapsedTime(),
      });

      this.toolbar.mount();
    }
  }

  /**
   * Start recording
   */
  async start(): Promise<void> {
    await this.recorder.start();
    this.screenshotMarker.setStartTime(Date.now());
    this.eventDetector.start();
    this.toolbar?.setState('recording');
  }

  /**
   * Pause recording
   */
  pause(): void {
    this.recorder.pause();
    this.toolbar?.setState('paused');
  }

  /**
   * Resume recording
   */
  resume(): void {
    this.recorder.resume();
    this.toolbar?.setState('recording');
  }

  /**
   * Stop recording
   */
  async stop(): Promise<RecordingResult | undefined> {
    // Stop event detection and marker tracking
    this.eventDetector.stop();
    this.screenshotMarker.stop();

    // Get markers before stopping recorder
    const markers = this.screenshotMarker.getMarkers();

    // Stop recorder and send markers for server-side generation
    const result = await this.recorder.stop(markers);
    this.toolbar?.setState('stopped');

    if (result) {
      this.toolbar?.setResult(result);

      // Auto-open playback page in new tab
      if (this.config.autoOpenPlayback !== false && result.playbackUrl) {
        window.open(result.playbackUrl, '_blank');
      }

      return result;
    }

    // Fallback for when there's no uploader (shouldn't happen in production)
    const events = this.recorder.getEvents();
    const fallbackResult: RecordingResult = {
      recordingId: `rec_${Date.now()}`,
      playbackUrl: '',
      duration: this.recorder.getElapsedTime(),
      eventCount: events.length,
      screenshotCount: markers.length,
    };

    this.toolbar?.setResult(fallbackResult);
    return fallbackResult;
  }

  /**
   * Add a manual screenshot marker
   */
  screenshot(): void {
    this.screenshotMarker.capture('manual');
  }

  /**
   * Restart - reset everything for a new recording
   */
  restart(): void {
    // Reset all components
    this.eventDetector.destroy();
    this.recorder.reset();
    this.screenshotMarker.reset();

    // Reset toolbar to idle state
    this.toolbar?.reset();
  }

  /**
   * Get current state
   */
  getState(): RecorderState {
    return this.recorder.getState();
  }

  /**
   * Get elapsed time
   */
  getElapsedTime(): number {
    return this.recorder.getElapsedTime();
  }

  /**
   * Destroy the recorder
   */
  destroy(): void {
    this.eventDetector.destroy();
    this.recorder.reset();
    this.screenshotMarker.reset();
    this.toolbar?.unmount();
    this.isInitialized = false;
  }

  /**
   * Handle state changes
   */
  private handleStateChange(state: RecorderState): void {
    this.toolbar?.setState(state);
  }
}

// URL parameters for auto-activation
const ACTIVATION_PARAM = '_bw_record';
const INVITE_PARAM = '_bw_invite';

/**
 * Check for auto-activation via URL parameter
 */
function checkAutoActivation(): string | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  return params.get(ACTIVATION_PARAM);
}

/**
 * Check for invite activation via URL parameter
 */
function checkInviteActivation(): string | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  return params.get(INVITE_PARAM);
}

/**
 * Initialize invite dialog with email
 */
function initInviteDialog(email: string): void {
  // Don't show if already completed
  if (InviteDialogController.isCompleted()) {
    console.log('[BWorlds LaunchKit] Invite already completed');
    return;
  }

  console.log('[BWorlds LaunchKit] Showing invite dialog for:', email);

  const dialog = new InviteDialogController(email);
  dialog.onComplete(() => {
    console.log('[BWorlds LaunchKit] Invite flow completed');
  });
  dialog.mount();

  // Expose for debugging
  if (typeof window !== 'undefined') {
    (window as unknown as { __bwInviteDialog: InviteDialogController }).__bwInviteDialog = dialog;
  }
}

/**
 * Initialize recorder with API key
 */
function initWithKey(apiKey: string): void {
  // Check for custom API endpoint via URL param or use default
  const params = new URLSearchParams(window.location.search);
  const apiEndpoint = params.get('_bw_api') || 'http://localhost:3941';

  console.log('[BWorlds Recorder] Initializing with endpoint:', apiEndpoint);

  const recorder = new DemoRecorder({
    apiKey,
    apiEndpoint,
    onComplete: (result) => {
      console.log('[BWorlds Recorder] Recording complete:', result.playbackUrl);
    },
    onError: (error) => {
      console.error('[BWorlds Recorder] Error:', error);
    },
  });

  recorder.init();

  // Expose to window for debugging
  if (typeof window !== 'undefined') {
    (window as unknown as { __bwRecorder: DemoRecorder }).__bwRecorder = recorder;
  }
}

/**
 * Initialize LaunchKit.
 *
 * With config: starts monitoring (heartbeat + error capture).
 *   init({ buildSlug: 'my-app' })
 *
 * Without config: legacy mode, checks URL params for recording/invite.
 *   init()
 */
export function init(config?: LaunchKitConfig): void {
  // Skip on server
  if (typeof window === 'undefined') return;

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => runInit(config));
  } else {
    runInit(config);
  }
}

function runInit(config?: LaunchKitConfig): void {
  // Monitoring mode: start heartbeat + error capture
  if (config?.buildSlug) {
    configureSender({
      buildSlug: config.buildSlug,
      apiEndpoint: config.apiEndpoint,
    });

    if (config.enableHeartbeat !== false) {
      startHeartbeat(config.buildSlug, config.heartbeatInterval);
    }

    if (config.enableErrorCapture !== false) {
      startErrorCapture(config.buildSlug);
    }

    // Expose stop functions for cleanup
    if (typeof window !== 'undefined') {
      (window as unknown as { __bwStopMonitoring: () => void }).__bwStopMonitoring = () => {
        stopHeartbeat();
        stopErrorCapture();
      };
    }

    return;
  }

  // Legacy mode: URL-param activated recording/invite
  const apiKey = checkAutoActivation();
  const inviteEmail = checkInviteActivation();

  if (inviteEmail) initInviteDialog(inviteEmail);
  if (apiKey) initWithKey(apiKey);
}

// Default export
export default DemoRecorder;
