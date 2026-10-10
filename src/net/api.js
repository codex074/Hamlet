// Thin fetch wrapper for the Hamlet account/village API (see docs/specs/2026-10-10-accounts-design.md).
// Always JSON + same-origin cookies. Failures throw ApiError with a Thai message ready to show to the player.

export class ApiError extends Error {
  constructor(message, { status = 0, network = false, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;     // HTTP status, 0 when the request never completed
    this.network = network;   // true when the server could not be reached at all
    this.body = body;
  }
}

const NETWORK_MESSAGE = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';

function fallbackMessage(status) {
  if (status === 401) return 'กรุณาเข้าสู่ระบบ';
  if (status === 403) return 'ไม่มีสิทธิ์ทำรายการนี้';
  if (status === 404) return 'ไม่พบข้อมูลที่ต้องการ';
  if (status === 413) return 'ข้อมูลใหญ่เกินไป';
  if (status === 429) return 'ลองมากเกินไป กรุณารอสักครู่แล้วลองใหม่';
  if (status >= 500) return 'เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่อีกครั้ง';
  return 'เกิดข้อผิดพลาด กรุณาลองใหม่';
}

// Low level: resolves { status, ok, data, json } where json says whether the body was JSON.
// Throws ApiError(network) only when fetch itself fails.
export async function rawRequest(method, path, body, opts = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body === undefined ? {} : body);
  }
  if (opts.keepalive) init.keepalive = true;
  if (opts.signal) init.signal = opts.signal;
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(NETWORK_MESSAGE, { network: true });
  }
  const type = res.headers.get('content-type') || '';
  const json = type.includes('json');
  let data = null;
  try {
    data = json ? await res.json() : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data, json };
}

export async function request(method, path, body, opts) {
  const r = await rawRequest(method, path, body, opts);
  if (r.ok) return r.data;
  const msg = r.data && typeof r.data.error === 'string' && r.data.error ? r.data.error : fallbackMessage(r.status);
  throw new ApiError(msg, { status: r.status, body: r.data });
}

export const get = (path, opts) => request('GET', path, undefined, opts);
export const post = (path, body, opts) => request('POST', path, body, opts);
export const put = (path, body, opts) => request('PUT', path, body, opts);
export const patch = (path, body, opts) => request('PATCH', path, body, opts);
export const del = (path, opts) => request('DELETE', path, undefined, opts);
