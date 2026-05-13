import type { OpenDevApi } from './index';

declare global {
  interface Window {
    opendev: OpenDevApi;
  }
}

export {};
