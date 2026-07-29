/** 浏览器存储模块的数据契约：包含支持的存储介质、条目字段和显示开关。 */

/** 存储介质类型。 */
export type StorageType = 'localStorage' | 'sessionStorage' | 'cookie';

/** Storage entry */
export interface StorageEntry {
  key: string;
  value: string;
  type: StorageType;
  /** Cookie-specific fields */
  domain?: string;
  path?: string;
  expires?: string;
  secure?: boolean;
  sameSite?: string;
  httpOnly?: boolean;
}

/** Storage panel options */
export interface StorageOptions {
  /** Whether to show localStorage */
  showLocalStorage: boolean;
  /** Whether to show sessionStorage */
  showSessionStorage: boolean;
  /** Whether to show cookies */
  showCookies: boolean;
}
