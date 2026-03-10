import type {
  Uploader,
  RecordingMetadata,
  SessionToken,
  EventChunk,
  ScreenshotMarker,
  RecordingResult,
} from './types';

/**
 * Mock uploader that logs to console
 * Will be replaced with real API implementation later
 */
export class MockUploader implements Uploader {
  private recordingId: string = '';
  private sessionToken: string = '';
  private metadata: RecordingMetadata | null = null;
  private chunks: EventChunk[] = [];
  private screenshotMarkers: ScreenshotMarker[] = [];

  async start(metadata: RecordingMetadata): Promise<SessionToken> {
    // Generate mock IDs
    this.recordingId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.sessionToken = `tok_${Math.random().toString(36).substr(2, 16)}`;
    this.metadata = metadata;
    this.chunks = [];
    this.screenshotMarkers = [];

    console.log('[BWorlds Recorder] Recording started', {
      recordingId: this.recordingId,
      metadata: {
        url: metadata.url,
        viewport: metadata.viewport,
        startedAt: new Date(metadata.startedAt).toISOString(),
      },
    });

    return {
      token: this.sessionToken,
      recordingId: this.recordingId,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
    };
  }

  async uploadChunk(chunk: EventChunk): Promise<void> {
    this.chunks.push(chunk);

    console.log('[BWorlds Recorder] Chunk uploaded', {
      recordingId: this.recordingId,
      chunkIndex: chunk.index,
      eventCount: chunk.events.length,
      totalEvents: this.chunks.reduce((sum, c) => sum + c.events.length, 0),
    });
  }

  async complete(
    duration: number,
    _eventCount: number,
    screenshotMarkers: ScreenshotMarker[]
  ): Promise<RecordingResult> {
    this.screenshotMarkers = screenshotMarkers;

    const result: RecordingResult = {
      recordingId: this.recordingId,
      playbackUrl: `https://app.bworlds.com/recordings/${this.recordingId}`,
      duration,
      eventCount: this.chunks.reduce((sum, c) => sum + c.events.length, 0),
      screenshotCount: screenshotMarkers.length,
    };

    console.log('[BWorlds Recorder] Recording completed', {
      ...result,
      metadata: this.metadata,
      screenshotMarkers: screenshotMarkers.map((m) => ({
        timestamp: m.timestamp,
        eventType: m.eventType,
      })),
    });

    // Log summary of all data (for debugging)
    console.log('[BWorlds Recorder] Recording data summary:', {
      chunks: this.chunks.length,
      screenshotMarkers: screenshotMarkers.length,
      totalEvents: result.eventCount,
      duration: `${Math.round(duration / 1000)}s`,
    });

    return result;
  }

  /**
   * Get all recorded data (for testing/debugging)
   */
  getData(): {
    metadata: RecordingMetadata | null;
    chunks: EventChunk[];
    screenshotMarkers: ScreenshotMarker[];
  } {
    return {
      metadata: this.metadata,
      chunks: this.chunks,
      screenshotMarkers: this.screenshotMarkers,
    };
  }
}

/**
 * Real API uploader
 */
export class ApiUploader implements Uploader {
  private apiEndpoint: string;
  private apiKey: string;
  private sessionToken: string = '';
  private recordingId: string = '';

  constructor(apiEndpoint: string, apiKey: string) {
    this.apiEndpoint = apiEndpoint;
    this.apiKey = apiKey;
  }

  async start(metadata: RecordingMetadata): Promise<SessionToken> {
    const response = await fetch(`${this.apiEndpoint}/api/recordings/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        metadata: {
          url: metadata.url,
          user_agent: metadata.userAgent,
          viewport: metadata.viewport,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to start recording: ${response.statusText}`);
    }

    const data = await response.json();
    this.sessionToken = data.session_token;
    this.recordingId = data.recording_id;

    return {
      token: data.session_token,
      recordingId: data.recording_id,
      expiresAt: data.expires_at,
    };
  }

  async uploadChunk(chunk: EventChunk): Promise<void> {
    const response = await fetch(
      `${this.apiEndpoint}/api/recordings/${this.recordingId}/chunk`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify({
          events: chunk.events,
          chunk_index: chunk.index,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to upload chunk: ${response.statusText}`);
    }
  }

  async complete(
    duration: number,
    eventCount: number,
    screenshotMarkers: ScreenshotMarker[]
  ): Promise<RecordingResult> {
    const response = await fetch(
      `${this.apiEndpoint}/api/recordings/${this.recordingId}/complete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sessionToken}`,
        },
        body: JSON.stringify({
          duration_ms: duration,
          event_count: eventCount,
          screenshot_markers: screenshotMarkers.map((m) => ({
            timestamp_ms: m.timestamp,
            event_type: m.eventType,
          })),
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to complete recording: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      recordingId: this.recordingId,
      playbackUrl: data.playback_url,
      duration,
      eventCount,
      screenshotCount: screenshotMarkers.length,
    };
  }
}
