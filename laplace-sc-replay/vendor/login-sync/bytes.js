import { LoginSyncError } from './errors.js';
export const utf8 = new TextEncoder();
/** Throws on invalid UTF-8 instead of substituting U+FFFD, so a wrong key can't decode into plausible text. */
export const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
export function concat(...parts) {
    const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
export function toHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function toBase64(bytes) {
    let binary = '';
    // `String.fromCharCode` takes a byte per argument; chunk so a multi-megabyte payload can't overflow the call stack.
    // `Reflect.apply` passes the typed array as is, where spreading it walks an iterator, several times slower
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += Reflect.apply(String.fromCharCode, null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}
function hasNativeBase64(ctor) {
    return 'fromBase64' in ctor && typeof ctor.fromBase64 === 'function';
}
const typedArray = Uint8Array;
export function fromBase64(text) {
    let binary;
    try {
        if (hasNativeBase64(typedArray))
            return typedArray.fromBase64(text);
        binary = atob(text);
    }
    catch (cause) {
        throw new LoginSyncError('malformed', 'blob is not valid base64', { cause });
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
