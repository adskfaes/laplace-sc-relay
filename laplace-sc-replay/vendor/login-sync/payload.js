import { LoginSyncError } from './errors.js';
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// Deliberately shallow, like the rest of the pipeline: cookie fields differ across browsers and releases, and rejecting
// one we don't recognize would lock users out of blobs that decrypt fine
function isCookieData(value) {
    return isRecord(value) && Object.values(value).every(cookies => Array.isArray(cookies) && cookies.every(isRecord));
}
// Unlike cookies, the values are checked: localStorage only holds strings, every writer has only ever sent strings, and
// readers are handed them typed as strings
function isStringMap(value) {
    return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}
function isLocalStorageData(value) {
    return isRecord(value) && Object.values(value).every(isStringMap);
}
/**
 * Checks the shape of a payload and fills in `local_storage_data`, which blobs from older writers, such as the retired
 * Python client, may lack. Fields it doesn't know pass through.
 */
export function toPayload(value) {
    if (!isRecord(value)) {
        throw new LoginSyncError('malformed', 'payload is not a JSON object');
    }
    const cookieData = value.cookie_data;
    if (!isCookieData(cookieData)) {
        throw new LoginSyncError('malformed', 'payload has no `cookie_data` object of cookie arrays');
    }
    const localStorageData = value.local_storage_data ?? {};
    if (!isLocalStorageData(localStorageData)) {
        throw new LoginSyncError('malformed', '`local_storage_data` is not an object of string maps');
    }
    return { ...value, cookie_data: cookieData, local_storage_data: localStorageData };
}
