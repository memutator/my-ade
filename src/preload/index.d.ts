import { ElectronAPI } from '@electron-toolkit/preload'
import type { AdeApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    ade: AdeApi
  }
}
