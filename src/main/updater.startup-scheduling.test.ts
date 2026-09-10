import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const {
  appMock,
  autoUpdaterMock,
  isMock,
  powerMonitorOnMock,
  fetchNudgeMock,
  shouldApplyNudgeMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

describe('updater', () => {
  afterEach(() => vi.unstubAllEnvs())

  beforeEach(() => {
    resetUpdaterMocks()
    vi.useFakeTimers()
  })

  it('does not load or configure electron-updater during dev setup', async () => {
    isMock.dev = true
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never)

    // Why: E2E dev-mode launches use a default app version that makes electron-updater throw during module load.
    expect(autoUpdaterMock.updateConfigPath).toBeUndefined()
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
  })

  it('delegates managed self-build updates without loading the release updater or stopping terminals', async () => {
    vi.stubEnv('ORCA_SELFBUILT_MANAGED', '1')
    const send = vi.fn()
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater({ webContents: { send } } as never)
    updater.checkForUpdates()
    updater.checkForUpdatesFromMenu({ localBuild: true })
    updater.downloadUpdate()
    updater.quitAndInstall()
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000)

    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(appMock.quit).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
    expect(fetchNudgeMock).not.toHaveBeenCalled()
    expect(updater.getRemoteServerUpdateSupport().automatic).toBe(false)
    expect(() => updater.checkForRemoteServerUpdate('selfbuilt')).toThrow(
      'remote_update_manual_required'
    )
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        message: 'Updates are managed by the Orca self-built updater.'
      })
    )
  })

  it('honors the packaged self-build marker when launched without wrapper environment', async () => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-selfbuilt-updater-'))
    const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    writeFileSync(join(resources, 'selfbuilt-managed.json'), '{}')
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    try {
      const updater = await loadUpdaterModule()
      updater.setupAutoUpdater({ webContents: { send: vi.fn() } } as never)
      updater.checkForUpdatesFromMenu()
      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    } finally {
      if (original) {
        Object.defineProperty(process, 'resourcesPath', original)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
      rmSync(resources, { recursive: true, force: true })
    }
  })

  it('runs a startup check immediately when the last background check is stale', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('starts nudge polling only after updater initialization is complete', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never)

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.on).toHaveBeenCalled()
    expect(fetchNudgeMock).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(
      fetchNudgeMock.mock.invocationCallOrder[0]
    )
    expect(autoUpdaterMock.on.mock.invocationCallOrder[0]).toBeLessThan(
      fetchNudgeMock.mock.invocationCallOrder[0]
    )
  })

  it('waits until the remaining interval before the next background check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 23 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('deduplicates rapid focus-triggered daily checks before checking status arrives', async () => {
    let lastUpdateCheckAt = Date.now()
    const mainWindow = { webContents: { send: vi.fn() } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => lastUpdateCheckAt
    })

    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')
    appMock.emit('browser-window-focus')

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  it('does not persist lastUpdateCheckAt when a focus-triggered check fails benignly', async () => {
    let lastUpdateCheckAt = Date.now()
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => lastUpdateCheckAt,
      setLastUpdateCheckAt
    })

    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('retries background checks sooner after a failed automatic check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
  })

  it('reschedules the next automatic check 24 hours after finding an available update', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await loadUpdaterModule()

    // Why: a startup check also arms its own 24h timer, which would fire at the same boundary as the
    // reschedule under test; entering 23h in makes the startup timer fire the check itself, so only
    // the result handler's re-arm can produce a check 24h later.
    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 23 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null
    })

    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    // Why: the boundary tick sweeps the updater's other timers (30-minute nudge poll, 45-second
    // stall guard) too, so pin the reschedule itself — nothing before 24h, a check once it elapses —
    // rather than an exact process-wide call total.
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  // Why: a no-op verifyUpdateCodeSignature override would silently accept every installer; keep electron-updater's Authenticode check (issue #631 resolved).
  it('does not disable Windows Authenticode verification on win32', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })

    const { setupAutoUpdater } = await loadUpdaterModule()

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    setupAutoUpdater(mainWindow as never)

    expect((autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature).toBeUndefined()
  })

  it('does not override verifyUpdateCodeSignature on non-Windows platforms', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })

    const { setupAutoUpdater } = await loadUpdaterModule()

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    setupAutoUpdater(mainWindow as never)

    expect((autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature).toBeUndefined()
  })
})
