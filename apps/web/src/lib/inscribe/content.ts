/**
 * How a file's bytes become Counterparty's `description` parameter.
 *
 * Counterparty consensus classifies a MIME type as textual or binary and stores the description
 * accordingly (build ref v3 §5.1): textual content goes across as UTF-8 text, binary as hex. This
 * mirrors `classify_mime_type` for the CURRENT rules — every mint composed by this app is at a
 * height past the extended-MIME gate (block 952,800), so the pre-gate variant is not reproduced.
 */

const TEXTUAL_APPLICATION_MIME_TYPES = new Set([
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/json',
  'application/manifest+json',
  'application/x-python-code',
  'application/x-sh',
  'application/x-csh',
  'application/x-tex',
  'application/x-latex',
  'application/postscript',
  'application/yaml',
  'application/x-yaml',
  'application/sql',
]);

/** Drop `; charset=…` and friends before matching. */
function stripParameters(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

export function classifyMimeType(mimeType: string): 'text' | 'binary' {
  const target = stripParameters(mimeType);
  if (
    target.startsWith('text/') ||
    target.startsWith('message/') ||
    target.endsWith('+xml') ||
    target.endsWith('+json')
  ) {
    return 'text';
  }
  return TEXTUAL_APPLICATION_MIME_TYPES.has(target) ? 'text' : 'binary';
}

const EXTENSION_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html',
  css: 'text/css', csv: 'text/csv', js: 'application/javascript',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml',
  yml: 'application/yaml', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4',
  webm: 'video/webm', wasm: 'application/wasm', zip: 'application/zip',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
};

/**
 * The MIME type to inscribe with.
 *
 * The browser's own `File.type` is preferred but is routinely empty (and, for some types, wrong),
 * so the extension decides whenever it can. The type is committed to by the envelope and cannot be
 * corrected later, which is why it is surfaced in the UI rather than applied silently.
 */
export function guessContentType(file: File): string {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  return EXTENSION_TYPES[ext] || file.type || 'application/octet-stream';
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export interface EncodedContent {
  description: string;
  classification: 'text' | 'binary';
}

/**
 * Encode content for the `description` compose parameter.
 *
 * A textual MIME type whose bytes are not valid UTF-8 is refused rather than coerced: the
 * replacement characters a lossy decode inserts would be committed to the chain permanently.
 */
export function encodeContent(body: Uint8Array, mimeType: string): EncodedContent {
  const classification = classifyMimeType(mimeType);
  if (classification === 'binary') {
    return { description: bytesToHex(body), classification };
  }
  const decoded = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try {
    text = decoded.decode(body);
  } catch {
    throw new Error(
      `This file is being inscribed as ${mimeType}, a textual type, but its bytes are not valid ` +
        'UTF-8. Convert it, or give it a binary MIME type.'
    );
  }
  return { description: text, classification };
}
