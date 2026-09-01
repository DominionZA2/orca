import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('os-opened markdown wiring', () => {
  const rawSource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const bootstrapSource = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-ipc-bootstrap.ts'),
    'utf8'
  )
  const preflightSource = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
    'utf8'
  )
  // Why: these assertions pin call shapes, not quote style, and the formatter owns the quotes.
  const source = rawSource.replaceAll('"', "'")

  it('captures argv before the serve-duplicate early return', () => {
    const captureIndex = source.indexOf(
      'osOpenedMarkdownFiles.capture(argv, publishOsOpenedMarkdownFiles)'
    )
    const serveGuardIndex = source.indexOf('if (!shouldActivateDesktopForSecondInstance(argv)) {')

    expect(captureIndex).toBeGreaterThanOrEqual(0)
    expect(serveGuardIndex).toBeGreaterThanOrEqual(0)
    // A duplicate `orca serve` returns early; capturing after that would drop the user's files.
    expect(captureIndex).toBeLessThan(serveGuardIndex)
  })

  it('claims the macOS open-file event so the default handler does not win it', () => {
    const handlerIndex = source.indexOf("app.on('open-file'")
    expect(handlerIndex).toBeGreaterThanOrEqual(0)

    const preventDefaultIndex = source.indexOf('event.preventDefault()', handlerIndex)
    const nextRegistrationIndex = source.indexOf('app.on(', handlerIndex + 1)
    expect(preventDefaultIndex).toBeGreaterThan(handlerIndex)
    expect(preventDefaultIndex).toBeLessThan(nextRegistrationIndex)
  })

  it('captures the cold-start argv and lets the renderer pull it after mount', () => {
    expect(source).toContain('osOpenedMarkdownFiles.capture(process.argv)')
    expect(bootstrapSource).toContain("ipcMain.handle('ui:consumePendingMarkdownFileOpens'")
  })

  it('keeps the single-instance callback narrow', () => {
    expect(preflightSource).toContain(
      'acquireSingleInstanceLock(app, options.requestDesktopActivation)'
    )
  })
})
