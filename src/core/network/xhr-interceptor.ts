import type { NetworkEntry } from '../../types';
import { nextId } from '../../utils/time';
import {
  createGlobalHook,
  detachGlobalHook,
  type GlobalHookHandle,
} from '../global-hook';
import { serializeBody, serializeXHRResponse } from './body-serialization';
import { finishNetworkEntry, type NetworkCaptureSink } from './network-capture';

type TrackedXMLHttpRequest = XMLHttpRequest & {
  _nc_entry?: NetworkEntry;
  _nc_headers?: Record<string, string>;
};

/** 独立接管并恢复 XHR 原型方法。 */
export class XHRInterceptor {
  private openHook: GlobalHookHandle<typeof XMLHttpRequest.prototype.open> | null = null;
  private sendHook: GlobalHookHandle<typeof XMLHttpRequest.prototype.send> | null = null;
  private setRequestHeaderHook: GlobalHookHandle<typeof XMLHttpRequest.prototype.setRequestHeader> | null = null;
  private active = false;

  constructor(private readonly sink: NetworkCaptureSink) {}

  install(): void {
    if (this.active) return;

    const self = this;

    const openHook = createGlobalHook(XMLHttpRequest.prototype.open, (link) => function (
      this: TrackedXMLHttpRequest,
      method: string,
      url: string | URL,
    ) {
      if (!link.active) return link.previous.apply(this, arguments as any);

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

      return link.previous.apply(this, arguments as any);
    } as typeof XMLHttpRequest.prototype.open);

    const setRequestHeaderHook = createGlobalHook(
      XMLHttpRequest.prototype.setRequestHeader,
      (link) => function (
      this: TrackedXMLHttpRequest,
      name: string,
      value: string,
    ) {
      if (!link.active) return link.previous.call(this, name, value);
      if (this._nc_headers) this._nc_headers[name] = value;
      return link.previous.call(this, name, value);
    } as typeof XMLHttpRequest.prototype.setRequestHeader,
    );

    const sendHook = createGlobalHook(XMLHttpRequest.prototype.send, (link) => function (
      this: TrackedXMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      if (!link.active) return link.previous.call(this, body);

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

      return link.previous.call(this, body);
    } as typeof XMLHttpRequest.prototype.send);

    this.openHook = openHook;
    this.sendHook = sendHook;
    this.setRequestHeaderHook = setRequestHeaderHook;
    this.active = true;

    XMLHttpRequest.prototype.open = openHook.hook;
    XMLHttpRequest.prototype.send = sendHook.hook;
    XMLHttpRequest.prototype.setRequestHeader = setRequestHeaderHook.hook;
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;

    if (this.openHook) {
      XMLHttpRequest.prototype.open = detachGlobalHook(XMLHttpRequest.prototype.open, this.openHook);
      this.openHook = null;
    }
    if (this.sendHook) {
      XMLHttpRequest.prototype.send = detachGlobalHook(XMLHttpRequest.prototype.send, this.sendHook);
      this.sendHook = null;
    }
    if (this.setRequestHeaderHook) {
      XMLHttpRequest.prototype.setRequestHeader = detachGlobalHook(
        XMLHttpRequest.prototype.setRequestHeader,
        this.setRequestHeaderHook,
      );
      this.setRequestHeaderHook = null;
    }
  }
}
