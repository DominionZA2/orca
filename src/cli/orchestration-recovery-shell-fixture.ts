import { afterEach, beforeEach, vi } from 'vitest'

export function registerPosixRecoveryShellFixture(): void {
  // These text fixtures target POSIX/Git Bash; Windows quoting has explicit shell cases.
  beforeEach(() => vi.stubEnv('ORCA_TERMINAL_WINDOWS_SHELL', 'bash'))
  afterEach(() => vi.unstubAllEnvs())
}
