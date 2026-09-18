import { ElectronAPI } from '@electron-toolkit/preload'
import type { MahasApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    mahas: MahasApi
  }
}
