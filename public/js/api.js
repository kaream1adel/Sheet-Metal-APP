// All server calls go through here. Errors come back as Arabic messages.
export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, 'مفيش اتصال بالبرنامج. اتأكد إن الكمبيوتر شغال.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) window.dispatchEvent(new Event('signed-out'));
  if (!res.ok) throw new ApiError(res.status, data.error || 'حصلت مشكلة', data);
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body) => api('PUT', url, body);
export const patch = (url, body) => api('PATCH', url, body);
export const del = (url) => api('DELETE', url, {});
