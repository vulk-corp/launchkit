import { record, type eventWithTime } from 'rrweb';
import type {
  RecorderConfig,
  RecorderState,
  RecordingMetadata,
  EventChunk,
  ScreenshotMarker,
  Uploader,
} from './types';
import { getPrivacyConfig } from './privacy';

const DEFAULT_MAX_DURATION = 15 * 60 * 1000; // 15 minutes
const CHUNK_INTERVAL = 30 * 1000; // 30 seconds
const CHUNK_EVENT_THRESHOLD = 100; // Or 100 events

export class Recorder {
  private config: Required<
    Pick<RecorderConfig, 'maxDuration' | 'maskInputs'>
  > &
    RecorderConfig;
  private state: RecorderState = 'idle';
  private events: eventWithTime[] = [];
  private stopFn: (() => void) | null = null;
  private startTime: number = 0;
  private pauseTime: number = 0;
  private totalPausedDuration: number = 0;
  private chunkIndex: number = 0;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private chunkTimer: ReturnType<typeof setInterval> | null = null;
  private uploader: Uploader | null = null;
  private metadata: RecordingMetadata | null = null;

  // Callbacks for external listeners
  private onEventCallback: ((event: eventWithTime) => void) | null = null;

  constructor(config: RecorderConfig) {
    this.config = {
      ...config,
      maxDuration: config.maxDuration ?? DEFAULT_MAX_DURATION,
      maskInputs: config.maskInputs ?? true,
    };
  }

  /**
   * Set the uploader instance
   */
  setUploader(uploader: Uploader): void {
    this.uploader = uploader;
  }

  /**
   * Set callback for new events (used by screenshot system)
   */
  onEvent(callback: (event: eventWithTime) => void): void {
    this.onEventCallback = callback;
  }

  /**
   * Get current recorder state
   */
  getState(): RecorderState {
    return this.state;
  }

  /**
   * Get elapsed recording time in milliseconds
   */
  getElapsedTime(): number {
    if (this.state === 'idle' || this.startTime === 0) {
      return 0;
    }

    if (this.state === 'paused') {
      return this.pauseTime - this.startTime - this.totalPausedDuration;
    }

    return Date.now() - this.startTime - this.totalPausedDuration;
  }

  /**
   * Get all recorded events
   */
  getEvents(): eventWithTime[] {
    return [...this.events];
  }

  /**
   * Start recording
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start recording: state is ${this.state}`);
    }

    this.setState('recording');
    this.startTime = Date.now();
    this.events = [];
    this.chunkIndex = 0;
    this.totalPausedDuration = 0;

    // Capture metadata
    this.metadata = {
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      startedAt: this.startTime,
    };

    // Initialize upload session if uploader is set
    if (this.uploader) {
      try {
        await this.uploader.start(this.metadata);
      } catch (error) {
        this.config.onError?.(error as Error);
        this.setState('idle');
        throw error;
      }
    }

    // Get privacy config
    const privacyConfig = getPrivacyConfig(this.config.maskInputs);

    // Start rrweb recording
    const stopRecording = record({
      emit: (event) => this.handleEvent(event),
      maskAllInputs: privacyConfig.maskAllInputs,
      maskTextSelector: privacyConfig.maskTextSelector ?? undefined,
      maskInputFn: privacyConfig.maskInputFn,
      blockSelector: privacyConfig.blockSelector,
      // Record mouse movement for better replay
      recordCanvas: true,
      collectFonts: true,
      // Inline styles for accurate replay
      inlineStylesheet: true,
      // Sample mouse movements to reduce event size
      sampling: {
        mousemove: true,
        mouseInteraction: true,
        scroll: 150, // Capture scroll every 150ms
        input: 'last', // Only capture last input value
      },
    });

    // Store stop function (handle undefined case)
    this.stopFn = stopRecording ?? null;

    // Set up auto-stop timer
    this.maxDurationTimer = setTimeout(() => {
      this.stop();
    }, this.config.maxDuration);

    // Set up chunk upload timer
    this.chunkTimer = setInterval(() => {
      this.flushChunk();
    }, CHUNK_INTERVAL);
  }

  /**
   * Pause recording
   */
  pause(): void {
    if (this.state !== 'recording') {
      throw new Error(`Cannot pause: state is ${this.state}`);
    }

    this.setState('paused');
    this.pauseTime = Date.now();

    // Stop capturing events (rrweb doesn't have native pause, so we filter)
  }

  /**
   * Resume recording
   */
  resume(): void {
    if (this.state !== 'paused') {
      throw new Error(`Cannot resume: state is ${this.state}`);
    }

    this.totalPausedDuration += Date.now() - this.pauseTime;
    this.setState('recording');
  }

  /**
   * Stop recording and finalize
   * @param screenshotMarkers - Markers for server-side screenshot generation
   * @returns Recording result from the API, or null if no uploader
   */
  async stop(screenshotMarkers: ScreenshotMarker[] = []): Promise<import('./types').RecordingResult | null> {
    if (this.state === 'idle' || this.state === 'stopped') {
      return null;
    }

    // Clean up timers
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }

    // Stop rrweb
    if (this.stopFn) {
      this.stopFn();
      this.stopFn = null;
    }

    this.setState('stopped');

    // Flush remaining events
    await this.flushChunk();

    // Complete upload if uploader is set
    if (this.uploader) {
      try {
        const result = await this.uploader.complete(
          this.getElapsedTime(),
          this.events.length,
          screenshotMarkers
        );
        this.config.onComplete?.(result);
        return result;
      } catch (error) {
        this.config.onError?.(error as Error);
        return null;
      }
    }

    return null;
  }

  /**
   * Handle incoming rrweb event
   */
  private handleEvent(event: eventWithTime): void {
    // Skip events during pause
    if (this.state === 'paused') {
      return;
    }

    this.events.push(event);

    // Notify external listeners
    this.onEventCallback?.(event);

    // Check if we need to flush due to event threshold
    if (this.events.length >= CHUNK_EVENT_THRESHOLD) {
      this.flushChunk();
    }
  }

  /**
   * Flush current events as a chunk
   */
  private async flushChunk(): Promise<void> {
    if (this.events.length === 0 || !this.uploader) {
      return;
    }

    const chunk: EventChunk = {
      index: this.chunkIndex++,
      events: [...this.events],
      timestamp: Date.now(),
    };

    // Clear events after creating chunk
    this.events = [];

    try {
      await this.uploader.uploadChunk(chunk);
    } catch (error) {
      // Re-add events on failure for retry
      this.events = [...chunk.events, ...this.events];
      this.chunkIndex--;
      this.config.onError?.(error as Error);
    }
  }

  /**
   * Update state and notify listeners
   */
  private setState(state: RecorderState): void {
    this.state = state;
    this.config.onStateChange?.(state);
  }

  /**
   * Reset recorder to initial state
   */
  reset(): void {
    this.stop();
    this.state = 'idle';
    this.events = [];
    this.startTime = 0;
    this.pauseTime = 0;
    this.totalPausedDuration = 0;
    this.chunkIndex = 0;
    this.metadata = null;
  }
}
