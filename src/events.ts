import type { eventWithTime, IncrementalSource } from 'rrweb';
import { EventType } from 'rrweb';
import type { ScreenshotCapture } from './screenshot';
import type { ScreenshotEventType } from './types';

/**
 * Event detection for automatic screenshots
 */
export class EventDetector {
  private screenshotCapture: ScreenshotCapture;
  private lastScrollY: number = 0;
  private viewportHeight: number = 0;
  private observers: MutationObserver[] = [];
  private isRecording: boolean = false;
  private hasInitialScreenshot: boolean = false;

  constructor(screenshotCapture: ScreenshotCapture) {
    this.screenshotCapture = screenshotCapture;
    this.viewportHeight = window.innerHeight;
  }

  /**
   * Start event detection
   */
  start(): void {
    if (this.isRecording) return;
    this.isRecording = true;

    this.lastScrollY = window.scrollY;
    this.viewportHeight = window.innerHeight;
    this.hasInitialScreenshot = false;

    // Set up mutation observer for modal detection
    this.setupModalDetection();

    // Set up scroll detection
    this.setupScrollDetection();

    // Set up form submission detection
    this.setupFormDetection();

    // Set up navigation detection
    this.setupNavigationDetection();

    // Take initial screenshot after a short delay (page fully loaded)
    setTimeout(() => {
      if (this.isRecording && !this.hasInitialScreenshot) {
        this.hasInitialScreenshot = true;
        this.triggerScreenshot('load');
      }
    }, 500);
  }

  /**
   * Stop event detection
   */
  stop(): void {
    this.isRecording = false;

    // Clean up observers
    this.observers.forEach((observer) => observer.disconnect());
    this.observers = [];

    // Remove event listeners
    window.removeEventListener('scroll', this.handleScroll);
    window.removeEventListener('popstate', this.handleNavigation);
  }

  /**
   * Handle rrweb event for additional detection
   */
  handleRrwebEvent(event: eventWithTime): void {
    if (!this.isRecording) return;

    // Detect form submissions from rrweb events
    if (event.type === EventType.IncrementalSnapshot) {
      const source = (event.data as { source?: IncrementalSource }).source;
      // IncrementalSource.Input = 5
      if (source === 5) {
        // Input event - could be part of form submission
        // We'll let the native form detection handle this
      }
    }
  }

  /**
   * Trigger a screenshot with event type
   */
  private triggerScreenshot(eventType: ScreenshotEventType): void {
    if (!this.isRecording) return;
    this.screenshotCapture.capture(eventType);
  }

  /**
   * Set up modal/dialog detection using MutationObserver
   */
  private setupModalDetection(): void {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLElement) {
              if (this.isModal(node)) {
                // Delay to let modal animate in
                setTimeout(() => {
                  this.triggerScreenshot('modal_open');
                }, 300);
                return;
              }
            }
          }
        }

        // Also detect attribute changes (e.g., dialog[open])
        if (mutation.type === 'attributes') {
          const target = mutation.target as HTMLElement;
          if (
            mutation.attributeName === 'open' &&
            target.tagName === 'DIALOG' &&
            target.hasAttribute('open')
          ) {
            setTimeout(() => {
              this.triggerScreenshot('modal_open');
            }, 300);
            return;
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'aria-hidden', 'aria-modal'],
    });

    this.observers.push(observer);
  }

  /**
   * Check if an element is a modal/dialog
   */
  private isModal(element: HTMLElement): boolean {
    // Check for common modal patterns
    const tagName = element.tagName.toLowerCase();

    // Native dialog
    if (tagName === 'dialog') {
      return true;
    }

    // ARIA modal
    if (
      element.getAttribute('role') === 'dialog' ||
      element.getAttribute('role') === 'alertdialog' ||
      element.getAttribute('aria-modal') === 'true'
    ) {
      return true;
    }

    // Common modal class names
    const className = element.className.toLowerCase();
    const modalPatterns = ['modal', 'dialog', 'overlay', 'popup', 'lightbox'];
    for (const pattern of modalPatterns) {
      if (className.includes(pattern)) {
        return true;
      }
    }

    // Check for fixed/absolute positioning with high z-index
    const style = window.getComputedStyle(element);
    if (
      (style.position === 'fixed' || style.position === 'absolute') &&
      parseInt(style.zIndex) > 100
    ) {
      // Additional check: is it covering a significant portion of viewport?
      const rect = element.getBoundingClientRect();
      const viewportArea = window.innerWidth * window.innerHeight;
      const elementArea = rect.width * rect.height;
      if (elementArea > viewportArea * 0.3) {
        return true;
      }
    }

    return false;
  }

  /**
   * Set up scroll detection
   */
  private setupScrollDetection(): void {
    window.addEventListener('scroll', this.handleScroll, { passive: true });
  }

  private handleScroll = (): void => {
    if (!this.isRecording) return;

    const currentScrollY = window.scrollY;
    const scrollDelta = Math.abs(currentScrollY - this.lastScrollY);

    // Capture on significant scroll (>50% viewport)
    if (scrollDelta > this.viewportHeight * 0.5) {
      this.lastScrollY = currentScrollY;
      // Use debounced capture for scroll
      this.screenshotCapture.captureDebounced('scroll', 500);
    }
  };

  /**
   * Set up form submission detection
   */
  private setupFormDetection(): void {
    document.addEventListener('submit', this.handleFormSubmit, true);
  }

  private handleFormSubmit = (_event: SubmitEvent): void => {
    if (!this.isRecording) return;

    // Capture before form submits
    this.triggerScreenshot('form_submit');
  };

  /**
   * Set up navigation detection
   */
  private setupNavigationDetection(): void {
    // Handle browser back/forward
    window.addEventListener('popstate', this.handleNavigation);

    // Intercept history.pushState and replaceState
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    history.pushState = (...args) => {
      originalPushState(...args);
      this.handleNavigation();
    };

    history.replaceState = (...args) => {
      originalReplaceState(...args);
      this.handleNavigation();
    };
  }

  private handleNavigation = (): void => {
    if (!this.isRecording) return;

    // Delay to let new content load
    setTimeout(() => {
      this.triggerScreenshot('navigation');
    }, 500);
  };

  /**
   * Clean up all listeners
   */
  destroy(): void {
    this.stop();
    document.removeEventListener('submit', this.handleFormSubmit, true);
  }
}
