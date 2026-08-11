import type { NetworkEntry } from '../../types';
import { nextId } from '../../utils/time';
import { serializeBody, serializeXHRResponse } from './body-serialization';
import { finishNetworkEntry, type NetworkCaptureSink } from './network-capture';

type TrackedXMLHttpRequest = XMLHttpRequest & {
  _nc_entry?: NetworkEntry;
  _nc_headers?: Record<string, string>;
};

/** 独立接管并恢复 XHR 原型方法。 */
export class XHRInterceptor {
  private originalOpen: typeof XMLHttpRequest.prototype.open | null = null;
  private originalSend: typeof XMLHttpRequest.prototype.send | null = null;
  private originalSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;
  private active = false;

  constructor(private readonly sink: NetworkCaptureSink) {}

  install(): void {
    if (this.active) return;

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const self = this;

    const installedOpen = function (
      this: TrackedXMLHttpRequest,
      method: string,
      url: string | URL,
    ) {
      this._nc_headers = {};
      this._nc_entry = {
        id: nextId(),
        type: 'xhr',
        method: method.toUpperCase(),
        url: String(url),
        requestHeaders: this._nc_headers,
        requestBody: null,
        status: 0,
        statusText: '',
        responseHeaders: {},
        responseBody: null,
        startTime: 0,
        endTime: 0,
        duration: 0,
        pending: true,
      };

      return originalOpen.apply(this, arguments as any);
    } as typeof XMLHttpRequest.prototype.open;

    const installedSetRequestHeader = function (
      this: TrackedXMLHttpRequest,
      name: string,
      value: string,
    ) {
      if (this._nc_headers) this._nc_headers[name] = value;
      return originalSetRequestHeader.call(this, name, value);
    } as typeof XMLHttpRequest.prototype.setRequestHeader;

    const installedSend = function (
      this: TrackedXMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const entry = this._nc_entry;
      if (entry && self.active) {
        entry.startTime = performance.now();
        entry.requestBody = serializeBody(body);
        self.sink.addEntry(entry);

        this.addEventListener('loadend', () => {
          if (!self.active) return;
          entry.status = this.status;
          entry.statusText = this.statusText;
          finishNetworkEntry(entry);

          const headerStr = this.getAllResponseHeaders();
          if (headerStr) {
            headerStr.split('\r\n').forEach((line) => {
              const separator = line.indexOf(':');
              if (separator > 0) {
                entry.responseHeaders[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
              }
            });
          }

          entry.responseBody = serializeXHRResponse(this);
          self.sink.emitUpdate(entry);
        });

        this.addEventListener('error', () => {
          if (!self.active) return;
          finishNetworkEntry(entry);
          entry.error = 'Network Error';
          self.sink.emitUpdate(entry);
        });
      }

      return originalSend.call(this, body);
    } as typeof XMLHttpRequest.prototype.send;

    this.originalOpen = originalOpen;
    this.originalSend = originalSend;
    this.originalSetRequestHeader = originalSetRequestHeader;
    this.active = true;

    XMLHttpRequest.prototype.open = installedOpen;
    XMLHttpRequest.prototype.send = installedSend;
    XMLHttpRequest.prototype.setRequestHeader = installedSetRequestHeader;
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;

    if (this.originalOpen) XMLHttpRequest.prototype.open = this.originalOpen;
    if (this.originalSend) XMLHttpRequest.prototype.send = this.originalSend;
    if (this.originalSetRequestHeader) {
      XMLHttpRequest.prototype.setRequestHeader = this.originalSetRequestHeader;
    }

    this.originalOpen = null;
    this.originalSend = null;
    this.originalSetRequestHeader = null;
  }
}
