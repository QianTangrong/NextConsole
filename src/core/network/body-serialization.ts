/** 非流式响应体预览的字符上限。 */
const MAX_BODY_PREVIEW_CHARS = 10000;

/** 将请求体归一化为可安全展示的轻量描述，不直接保留二进制内容。 */
export function serializeBody(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const obj: Record<string, string> = {};
    body.forEach((value, key) => {
      obj[key] = typeof value === 'string' ? value : `[File: ${(value as File).name}]`;
    });
    return obj;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob: ${body.size} bytes]`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer: ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) return `[${body.constructor.name}: ${body.byteLength} bytes]`;
  return String(body);
}

/** 按 XHR responseType 安全生成响应预览，读取失败时返回稳定占位文本。 */
export function serializeXHRResponse(xhr: XMLHttpRequest): unknown {
  const responseType = xhr.responseType || 'text';

  if (responseType === 'json') return xhr.response;
  if (responseType === 'blob') {
    const blob = xhr.response as Blob | null;
    return blob ? `[Blob: ${blob.size} bytes]` : '[Blob]';
  }
  if (responseType === 'arraybuffer') {
    const buffer = xhr.response as ArrayBuffer | null;
    return buffer ? `[ArrayBuffer: ${buffer.byteLength} bytes]` : '[ArrayBuffer]';
  }
  if (responseType === 'document') {
    const doc = xhr.response as Document | null;
    return doc ? `[Document: ${doc.contentType || 'unknown'}]` : '[Document]';
  }

  try {
    const contentType = xhr.getResponseHeader('content-type') || '';
    const text = xhr.responseText || '';
    const bodyText = text.length > MAX_BODY_PREVIEW_CHARS
      ? `${text.slice(0, MAX_BODY_PREVIEW_CHARS)}...(truncated)`
      : text;

    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch {
        return bodyText;
      }
    }

    return bodyText;
  } catch {
    return '[Unable to read body]';
  }
}
