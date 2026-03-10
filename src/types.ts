import type { eventWithTime } from 'rrweb';

/**
 * Configuration for LaunchKit monitoring (heartbeat + error capture).
 * Pass to init() to enable monitoring without the recording toolbar.
 */
export interface LaunchKitConfig {
  /** Your build slug from the BWORLDS dashboard */
  buildSlug: string;
  /** API endpoint (defaults to https://api.bworlds.co) */
  apiEndpoint?: string;
  /** Heartbeat interval in ms (default: 5 minutes) */
  heartbeatInterval?: number;
  /** Enable error capture (default: true) */
  enableErrorCapture?: boolean;
  /** Enable heartbeat (default: true) */
  enableHeartbeat?: boolean;
}

export type ToolbarPosition =
  | 'bottom-right'
  | 'bottom-left'
  | 'top-right'
  | 'top-left';

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped';

export interface RecorderConfig {
  /** API key for authentication */
  apiKey: string;
  /** API endpoint (defaults to https://api.bworlds.com) */
  apiEndpoint?: string;
  /** Maximum recording duration in ms (default: 15 minutes) */
  maxDuration?: number;
  /** Mask sensitive inputs (default: true) */
  maskInputs?: boolean;
  /** Automatically open playback page when recording stops (default: true) */
  autoOpenPlayback?: boolean;
  /** Toolbar configuration */
  toolbar?: {
    /** Position of the toolbar (default: bottom-right) */
    position?: ToolbarPosition;
    /** Whether to show the toolbar (default: true) */
    enabled?: boolean;
  };
  /** Callback when recording completes */
  onComplete?: (result: RecordingResult) => void;
  /** Callback when recording state changes */
  onStateChange?: (state: RecorderState) => void;
  /** Callback on error */
  onError?: (error: Error) => void;
}

export interface RecordingResult {
  /** Unique recording ID */
  recordingId: string;
  /** URL to view the recording */
  playbackUrl: string;
  /** Duration in milliseconds */
  duration: number;
  /** Number of events recorded */
  eventCount: number;
  /** Number of screenshots captured */
  screenshotCount: number;
}

export interface RecordingMetadata {
  /** URL where recording was made */
  url: string;
  /** User agent string */
  userAgent: string;
  /** Viewport dimensions */
  viewport: {
    width: number;
    height: number;
  };
  /** Recording start timestamp */
  startedAt: number;
}

export interface Screenshot {
  /** Screenshot ID */
  id: string;
  /** Timestamp relative to recording start */
  timestamp: number;
  /** Event type that triggered the screenshot */
  eventType: ScreenshotEventType;
  /** Base64 encoded PNG data */
  dataUrl: string;
}

/**
 * Screenshot marker - timestamp and event type for server-side generation
 */
export interface ScreenshotMarker {
  /** Timestamp relative to recording start (ms) */
  timestamp: number;
  /** Event type that triggered the marker */
  eventType: ScreenshotEventType;
}

export type ScreenshotEventType =
  | 'load'
  | 'navigation'
  | 'form_submit'
  | 'modal_open'
  | 'scroll'
  | 'manual';

export interface EventChunk {
  /** Chunk index (0-based) */
  index: number;
  /** Events in this chunk */
  events: eventWithTime[];
  /** Timestamp when chunk was created */
  timestamp: number;
}

export interface SessionToken {
  /** Token for API authentication */
  token: string;
  /** Recording ID this token is for */
  recordingId: string;
  /** Expiration timestamp */
  expiresAt: number;
}

// Uploader interface (for mock and real implementations)
export interface Uploader {
  /** Initialize recording session */
  start(metadata: RecordingMetadata): Promise<SessionToken>;
  /** Upload event chunk */
  uploadChunk(chunk: EventChunk): Promise<void>;
  /** Complete recording with screenshot markers for server-side generation */
  complete(
    duration: number,
    eventCount: number,
    screenshotMarkers: ScreenshotMarker[]
  ): Promise<RecordingResult>;
}
