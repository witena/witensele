/**
 * `parseLaunchArgs`, against the two argument vectors that really occur.
 *
 * The packaged shape is not a guess: WP-0a launched the signed bundle with
 * `open -g -j … --args --background` and logged `process.argv` from inside the
 * app, which was exactly `['<bundle>/Contents/MacOS/Witena', '--background']`.
 * The development shape comes from `electron .` and the Playwright harness,
 * which add the app directory and their own switches. Both are pinned here,
 * because a parser that reads a fixed position would pass on one and fail on
 * the other — and the one it failed on would be the shipped build.
 */
import { describe, expect, it } from 'vitest'
import { chatUrl } from '@shared/mcp-tools'
import { BACKGROUND_FLAG, CHAT_URL_SCHEME, parseLaunchArgs } from './launch-args'

const EXEC = '/Applications/Witena.app/Contents/MacOS/Witena'
const CHAT_ID = '4f2b1c8e-9d3a-4b6f-8e21-0a7c5d9e1b34'

describe('parseLaunchArgs', () => {
  it('reads nothing out of a plain launch', () => {
    expect(parseLaunchArgs([EXEC])).toEqual({ background: false, openChatId: null })
  })

  it('finds --background in the packaged vector, which has no other entry', () => {
    expect(parseLaunchArgs([EXEC, BACKGROUND_FLAG])).toEqual({
      background: true,
      openChatId: null
    })
  })

  it('finds --background in the development vector, which has extra entries', () => {
    const argv = ['/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', '.']
    expect(parseLaunchArgs(argv)).toEqual({ background: false, openChatId: null })
    expect(parseLaunchArgs([...argv, BACKGROUND_FLAG])).toEqual({
      background: true,
      openChatId: null
    })
    // The harness adds switches of its own; they must not confuse either answer.
    expect(
      parseLaunchArgs([...argv, '--inspect=0', BACKGROUND_FLAG, '--remote-debugging-port=0'])
    ).toEqual({ background: true, openChatId: null })
  })

  it('reads a chat deep link from any position, with or without the flag', () => {
    expect(parseLaunchArgs([EXEC, chatUrl(CHAT_ID)])).toEqual({
      background: false,
      openChatId: CHAT_ID
    })
    expect(parseLaunchArgs([EXEC, BACKGROUND_FLAG, chatUrl(CHAT_ID)])).toEqual({
      background: true,
      openChatId: CHAT_ID
    })
    expect(parseLaunchArgs(['electron', '.', chatUrl(CHAT_ID), '--background'])).toEqual({
      background: true,
      openChatId: CHAT_ID
    })
  })

  it('ignores the executable itself, so a path that looks like a link is not one', () => {
    // Contrived, but it is the whole reason the scan starts at index 1: argv[0]
    // is a path the app was started from, never something the user asked for.
    expect(parseLaunchArgs([chatUrl(CHAT_ID)])).toEqual({ background: false, openChatId: null })
    expect(parseLaunchArgs([BACKGROUND_FLAG])).toEqual({ background: false, openChatId: null })
  })

  it('ignores anything that is not exactly a chat link', () => {
    const rejected = [
      'witena://chat/not-a-uuid',
      `witena://chat/${CHAT_ID}/`,
      `witena://chat/${CHAT_ID}?x=1`,
      `witena://agent/${CHAT_ID}`,
      `https://example.com/chat/${CHAT_ID}`,
      '--background=1',
      '-background'
    ]
    for (const arg of rejected) {
      expect(parseLaunchArgs([EXEC, arg])).toEqual({ background: false, openChatId: null })
    }
  })

  it('takes the first link when a vector somehow carries two', () => {
    const other = '11111111-2222-3333-4444-555555555555'
    expect(parseLaunchArgs([EXEC, chatUrl(CHAT_ID), chatUrl(other)]).openChatId).toBe(CHAT_ID)
  })

  it('declares the scheme the shared link builder actually speaks', () => {
    // `src/shared/mcp-tools.ts` keeps its prefix private, and `index.ts` has to
    // hand a bare scheme to `setAsDefaultProtocolClient` while
    // `electron-builder.yml` repeats it in `protocols`. This is the assertion
    // that keeps those three spellings from drifting apart.
    expect(chatUrl(CHAT_ID).startsWith(`${CHAT_URL_SCHEME}://`)).toBe(true)
  })
})
