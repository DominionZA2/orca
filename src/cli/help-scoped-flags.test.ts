import { describe, expect, it } from 'vitest'
import { formatCommandHelp } from './help'

function help(command: string, flag: string): string {
  return formatCommandHelp({
    path: command.split(' '),
    usage: `orca ${command}`,
    summary: 'Flag help regression',
    allowedFlags: [flag]
  })
}

describe('upstream skills help with custom workspace selectors', () => {
  it.each([
    ['skills get', 'full', 'Print the full guide with bundled references'],
    ['skills get', 'reference', 'Print one bundled reference by name'],
    ['skills install', 'agent', 'Comma-separated install targets'],
    ['browser open', 'worktree', 'folder:<id>'],
    ['worktree show', 'worktree', 'folder:<id>']
  ])('preserves %s --%s help', (command, flag, expected) => {
    expect(help(command, flag)).toContain(expected)
  })

  it('keeps git-only selectors out of folder-workspace help', () => {
    expect(help('worktree rm', 'worktree')).not.toContain('folder:<id>')
  })
})
