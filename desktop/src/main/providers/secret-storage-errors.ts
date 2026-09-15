// Operation-neutral: the same keychain protects saved tokens and API keys,
// on reads as well as writes. Unavailable does not prove it is locked.
export const SECRET_STORAGE_UNAVAILABLE_MESSAGE =
  'Secure key storage is currently unavailable. Unlock your system keychain if it is locked, then retry.';

// Never include the underlying crypto exception: it may contain secret data.
export const SECRET_DECRYPTION_FAILED_MESSAGE =
  'Saved credentials could not be decrypted. Unlock your system keychain if it is locked, then retry. If this continues, reconnect the affected account or re-enter its API key in Settings → Model Providers.';
