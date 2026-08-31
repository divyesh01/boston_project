async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true) {
    const error = /** @type {Error & { code?: string, status?: number }} */ (
      new Error(data.error || `Account API failed (${response.status})`)
    );
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

export function getAccessIdentity() {
  return request('/api/access/session', { method: 'POST' });
}

export function invokeAccountData(action, payload = {}) {
  return request('/api/account-data', {
    method: 'POST',
    body: JSON.stringify({ action, ...payload }),
  });
}
