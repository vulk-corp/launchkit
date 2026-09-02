/**
 * Inline data scrub for recorded rrweb events.
 *
 * A host app that renders photos as `data:` URLs (FileReader.readAsDataURL,
 * AI images returned as base64) puts every photo verbatim into the event that
 * serializes it. One React commit inserting a photo set yields a single
 * mutation event of tens of megabytes, far beyond what any chunk can carry.
 * The scrub replaces each oversized inline data value with a small neutral
 * placeholder so the element keeps its place in the tree (layout and click
 * targets survive) while the recording stays uploadable.
 *
 * Operates on the serialized event only. The host DOM is never touched.
 */

// Real photos are hundreds of kilobytes; icons and tiny sprites stay under a
// few kilobytes. Everything below this size ships untouched.
export const MAX_INLINE_DATA_ATTRIBUTE_BYTES = 32 * 1024;

// A 1x1 grey SVG that stretches to whatever box the element has, so the
// replay shows a neutral block where the image was.
export const INLINE_DATA_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1' viewBox='0 0 1 1' preserveAspectRatio='none'%3E%3Crect width='1' height='1' fill='%23d9d9d9'/%3E%3C/svg%3E";

// rrweb wire constants (EventType and IncrementalSource enums). Hard-coded so
// this module never imports rrweb: the replay module loads rrweb lazily and
// keeps that boundary.
const FULL_SNAPSHOT_EVENT_TYPE = 2;
const INCREMENTAL_SNAPSHOT_EVENT_TYPE = 3;
const MUTATION_SOURCE = 0;

const INLINE_DATA_URL_PREFIX = /^data:/i;
// Attributes whose whole value is a URL.
const URL_ATTRIBUTE_NAMES = ['src', 'srcset', 'poster', 'href', 'xlink:href'] as const;
// Attributes carrying CSS text, where inline data hides inside url() tokens.
// rrweb stores a stylesheet's text under `_cssText`.
const CSS_ATTRIBUTE_NAMES = ['style', '_cssText'] as const;
const CSS_INLINE_DATA_URL_TOKEN =
  /url\(\s*(?:"data:[^"]*"|'data:[^']*'|data:[^)]*)\s*\)/gi;

export interface InlineDataScrubResult {
  replacedCount: number;
  replacedBytes: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * Replace every oversized inline data value in the event with the placeholder,
 * in place. Returns how many values were replaced and how many characters they
 * held. Events of other kinds pass through untouched.
 */
export function scrubInlineData(event: unknown): InlineDataScrubResult {
  const result: InlineDataScrubResult = { replacedCount: 0, replacedBytes: 0 };
  if (!isRecord(event) || !isRecord(event.data)) return result;
  const data = event.data;

  if (event.type === FULL_SNAPSHOT_EVENT_TYPE) {
    scrubNodeTree(data.node, result);
    return result;
  }

  if (event.type === INCREMENTAL_SNAPSHOT_EVENT_TYPE && data.source === MUTATION_SOURCE) {
    if (Array.isArray(data.adds)) {
      for (const added of data.adds) {
        if (isRecord(added)) scrubNodeTree(added.node, result);
      }
    }
    if (Array.isArray(data.attributes)) {
      for (const mutation of data.attributes) {
        if (isRecord(mutation)) scrubAttributes(mutation.attributes, result);
      }
    }
  }
  return result;
}

function scrubNodeTree(root: unknown, result: InlineDataScrubResult): void {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isRecord(node)) continue;
    scrubAttributes(node.attributes, result);
    const children = node.childNodes;
    if (Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0; i -= 1) pending.push(children[i]);
    }
  }
}

function scrubAttributes(attributes: unknown, result: InlineDataScrubResult): void {
  if (!isRecord(attributes)) return;

  for (const name of URL_ATTRIBUTE_NAMES) {
    const value = attributes[name];
    if (!isOversizedInlineDataUrl(value)) continue;
    result.replacedCount += 1;
    result.replacedBytes += value.length;
    attributes[name] = INLINE_DATA_PLACEHOLDER;
  }

  for (const name of CSS_ATTRIBUTE_NAMES) {
    const value = attributes[name];
    if (typeof value === 'string') {
      if (value.length > MAX_INLINE_DATA_ATTRIBUTE_BYTES) {
        attributes[name] = scrubCssText(value, result);
      }
    } else if (name === 'style' && isRecord(value)) {
      scrubStyleDeclarations(value, result);
    }
  }
}

function isOversizedInlineDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > MAX_INLINE_DATA_ATTRIBUTE_BYTES &&
    INLINE_DATA_URL_PREFIX.test(value)
  );
}

/**
 * Replace each oversized `url(data:...)` token; every other token and the
 * surrounding declarations stay verbatim.
 */
function scrubCssText(css: string, result: InlineDataScrubResult): string {
  return css.replace(CSS_INLINE_DATA_URL_TOKEN, (token) => {
    if (token.length <= MAX_INLINE_DATA_ATTRIBUTE_BYTES) return token;
    result.replacedCount += 1;
    result.replacedBytes += token.length;
    return `url(${INLINE_DATA_PLACEHOLDER})`;
  });
}

/**
 * A mutation records a changed `style` attribute as a per-property diff:
 * `{ property: value | [value, priority] | false }`.
 */
function scrubStyleDeclarations(
  declarations: UnknownRecord,
  result: InlineDataScrubResult,
): void {
  for (const property of Object.keys(declarations)) {
    const entry = declarations[property];
    if (typeof entry === 'string') {
      if (entry.length > MAX_INLINE_DATA_ATTRIBUTE_BYTES) {
        declarations[property] = scrubCssText(entry, result);
      }
    } else if (
      Array.isArray(entry) &&
      typeof entry[0] === 'string' &&
      entry[0].length > MAX_INLINE_DATA_ATTRIBUTE_BYTES
    ) {
      entry[0] = scrubCssText(entry[0], result);
    }
  }
}
