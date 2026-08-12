/**
 * 浏览器存储核心：读取、修改和删除 localStorage、sessionStorage 与 Cookie 条目。
 */
import type { StorageEntry, StorageOptions, StorageType } from '../types';
import { EventEmitter } from '../utils/event-emitter';

type StorageEvents = {
  update: () => void;
};

const DEFAULT_OPTIONS: StorageOptions = {
  showLocalStorage: true,
  showSessionStorage: true,
  showCookies: true,
};

/**
 * 读取和管理 localStorage、sessionStorage 与 Cookie；存储在读取时获取，避免全局拦截副作用。
 */
export class StorageCore extends EventEmitter<StorageEvents> {
  private options: StorageOptions;

  constructor(options?: Partial<StorageOptions>) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  init(): void {
    // 存储按需读取即可，避免覆写宿主页面的 Storage API。
  }

  /** 按配置和关键词返回可见存储条目。 */
  getEntries(filter?: string): StorageEntry[] {
    const entries: StorageEntry[] = [];

    if (this.options.showLocalStorage) {
      entries.push(...this.readWebStorage('localStorage', filter));
    }
    if (this.options.showSessionStorage) {
      entries.push(...this.readWebStorage('sessionStorage', filter));
    }
    if (this.options.showCookies) {
      entries.push(...this.readCookies(filter));
    }

    return entries;
  }

  /** 逐项读取 Web Storage；浏览器拒绝访问时返回已读取部分，不能中断面板。 */
  private readWebStorage(type: 'localStorage' | 'sessionStorage', filter?: string): StorageEntry[] {
    const entries: StorageEntry[] = [];
    try {
      const storage = type === 'localStorage' ? localStorage : sessionStorage;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key === null) continue;
        if (filter && !key.toLowerCase().includes(filter.toLowerCase())) continue;

        entries.push({
          key,
          value: storage.getItem(key) || '',
          type,
        });
      }
    } catch {
      // Storage may be unavailable (iframe cross-origin, privacy mode, etc.)
    }

    return entries;
  }

  /** 将 document.cookie 解析为表格条目；HttpOnly Cookie 本身不可由页面脚本读取。 */
  private readCookies(filter?: string): StorageEntry[] {
    const entries: StorageEntry[] = [];
    const cookies = document.cookie;
    if (!cookies) return entries;

    const pairs = cookies.split(';');
    for (const pair of pairs) {
      const eqIndex = pair.indexOf('=');
      if (eqIndex < 0) continue;
      const key = pair.slice(0, eqIndex).trim();
      const rawValue = pair.slice(eqIndex + 1).trim();

      if (filter && !key.toLowerCase().includes(filter.toLowerCase())) continue;

      let value: string;
      try {
        value = decodeURIComponent(rawValue);
      } catch {
        value = rawValue;
      }

      entries.push({
        key,
        value,
        type: 'cookie',
      });
    }

    return entries;
  }

  /** 写入指定存储介质，并在成功后通知视图重新读取。 */
  setItem(type: StorageType, key: string, value: string, cookieOptions?: {
    domain?: string;
    path?: string;
    expires?: string;
    secure?: boolean;
    sameSite?: string;
  }, notify = true): boolean {
    let ok = false;
    try {
      if (type === 'localStorage') {
        localStorage.setItem(key, value);
        ok = true;
      } else if (type === 'sessionStorage') {
        sessionStorage.setItem(key, value);
        ok = true;
      } else if (type === 'cookie') {
        let cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        if (cookieOptions?.domain) cookie += `; domain=${cookieOptions.domain}`;
        if (cookieOptions?.path) cookie += `; path=${cookieOptions.path}`;
        else cookie += `; path=/`;
        if (cookieOptions?.expires) cookie += `; expires=${cookieOptions.expires}`;
        if (cookieOptions?.secure) cookie += `; secure`;
        if (cookieOptions?.sameSite) cookie += `; SameSite=${cookieOptions.sameSite}`;
        document.cookie = cookie;
        ok = this.readCookies().some((entry) => entry.key === key && entry.value === value);
      }
    } catch {
      // Storage may be unavailable
    }
    if (notify) this.emit('update');
    return ok;
  }

  /** 删除单个存储条目；Cookie 通过设置过期时间实现删除。 */
  removeItem(type: StorageType, key: string, notify = true): void {
    try {
      if (type === 'localStorage') {
        localStorage.removeItem(key);
      } else if (type === 'sessionStorage') {
        sessionStorage.removeItem(key);
      } else if (type === 'cookie') {
        // Try common paths to ensure deletion works
        const paths = ['/', window.location.pathname];
        for (const path of paths) {
          document.cookie = `${encodeURIComponent(key)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`;
        }
      }
    } catch {
      // Storage may be unavailable
    }
    if (notify) this.emit('update');
  }

  /** 清空一种存储介质；Cookie 逐条过期以避免影响其他域。 */
  clearAll(type: StorageType): void {
    try {
      if (type === 'localStorage') {
        localStorage.clear();
      } else if (type === 'sessionStorage') {
        sessionStorage.clear();
      } else if (type === 'cookie') {
        const entries = this.readCookies();
        for (const entry of entries) {
          this.removeItem('cookie', entry.key, false);
        }
      }
    } catch {
      // Storage may be unavailable
    }
    this.emit('update');
  }

  destroy(): void {
    this.removeAllListeners();
  }
}
