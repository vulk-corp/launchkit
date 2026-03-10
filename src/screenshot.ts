import type { ScreenshotMarker, ScreenshotEventType } from './types';

/**
 * Screenshot marker system - tracks timestamps for server-side screenshot generation
 */
export class ScreenshotMarkerTracker {
  private markers: ScreenshotMarker[] = [];
  private recordingStartTime: number = 0;
  private isRecording: boolean = false;

  /**
   * Set recording start time for timestamp calculation
   */
  setStartTime(startTime: number): void {
    this.recordingStartTime = startTime;
    this.isRecording = true;
  }

  /**
   * Get all captured markers
   */
  getMarkers(): ScreenshotMarker[] {
    return [...this.markers];
  }

  /**
   * Get marker count
   */
  getCount(): number {
    return this.markers.length;
  }

  /**
   * Mark a timestamp for screenshot generation
   * (renamed from capture() for clarity, but keeping similar signature)
   */
  capture(eventType: ScreenshotEventType): ScreenshotMarker | null {
    if (!this.isRecording || this.recordingStartTime === 0) {
      return null;
    }

    const marker: ScreenshotMarker = {
      timestamp: Date.now() - this.recordingStartTime,
      eventType,
    };

    this.markers.push(marker);

    console.log('[BWorlds Recorder] Screenshot marker added', {
      timestamp: marker.timestamp,
      eventType: marker.eventType,
      totalMarkers: this.markers.length,
    });

    return marker;
  }

  /**
   * Mark with debounce for scroll events
   */
  private captureDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  captureDebounced(eventType: ScreenshotEventType, delay: number = 500): void {
    if (this.captureDebounceTimer) {
      clearTimeout(this.captureDebounceTimer);
    }

    this.captureDebounceTimer = setTimeout(() => {
      this.capture(eventType);
      this.captureDebounceTimer = null;
    }, delay);
  }

  /**
   * Stop tracking (called when recording stops)
   */
  stop(): void {
    this.isRecording = false;
    if (this.captureDebounceTimer) {
      clearTimeout(this.captureDebounceTimer);
      this.captureDebounceTimer = null;
    }
  }

  /**
   * Reset state
   */
  reset(): void {
    this.markers = [];
    this.recordingStartTime = 0;
    this.isRecording = false;
    if (this.captureDebounceTimer) {
      clearTimeout(this.captureDebounceTimer);
      this.captureDebounceTimer = null;
    }
  }
}

// Keep old name as alias for minimal code changes in other files
export { ScreenshotMarkerTracker as ScreenshotCapture };
