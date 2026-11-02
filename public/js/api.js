// All server calls go through here. Errors come back as Arabic messages (ApiError.message);
// ApiError.data carries the server's extra fields (similar, existing, field, ...).
export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

// Photos and the Excel file take longer to send over a phone; everything else answers quickly.
const TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 180000;
const isUpload = (url) => /^\/api\/(operations\/photos|import)/.test(url) || /\/photo$/.test(url);

// What to say when the answer isn't the app's own JSON (the tunnel or the PC dropped it).
function plainMessage(status) {
  if (status === 413) return 'الملف كبير قوي — صوّر الورقة تاني من غير زوم';
  if ([502, 503, 504, 522, 523, 524].includes(status)) {
    return 'الاتصال بالكمبيوتر اتقطع. لو كنت بترفع صورة، استنى شوية وحدّث الصفحة — ممكن تكون اترفعت.';
  }
  if (status === 501) return 'قيد البناء';
  return 'حصلت مشكلة — جرب تاني';
}

export async function api(method, url, body, { timeout } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const ms = timeout ?? (isUpload(url) ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
  opts.signal = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ApiError(0, method === 'GET' ? 'البرنامج مردش — جرب تاني' : 'البرنامج مردش في الوقت. اتأكد إن اللي عملته اتسجل قبل ما تعيده.');
    }
    throw new ApiError(0, 'مفيش اتصال بالبرنامج. اتأكد إن الكمبيوتر شغال والنت واصل.');
  }
  const json = (res.headers.get('content-type') || '').includes('application/json');
  const data = json ? await res.json().catch(() => ({})) : {};
  if (res.status === 401 && !url.endsWith('/login')) window.dispatchEvent(new Event('signed-out'));
  if (!res.ok) throw new ApiError(res.status, data.error || plainMessage(res.status), data);
  return data;
}

// "?a=1&b=x" from an object, skipping empty values.
export const qs = (params = {}) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${new URLSearchParams(p).toString()}` : '';
};

export const get = (url, params) => api('GET', url + qs(params));
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body) => api('PUT', url, body);
export const patch = (url, body) => api('PATCH', url, body);
export const del = (url, body = {}) => api('DELETE', url, body);
