/**
 * What a shell command line is allowed to be.
 *
 * S5.4 made `run_command` "anything the user clicks Allow on": the permission
 * card printed the line verbatim and the whole boundary was the user reading it
 * carefully at the end of a long round. That is the wrong shape for two classes
 * of command. `sudo rm -rf /` should never be *offered* — a prompt whose right
 * answer is always Deny is a trap, not a question — and `git push` should be
 * asked about even in a chat where the user pressed "Always allow" an hour ago,
 * because the grant was about running commands, not about publishing.
 *
 * So every line is classified before anything else happens:
 *
 * | Verdict | What happens |
 * |---|---|
 * | `blocked` | The tool throws. No prompt, no shell, and the model reads why |
 * | `dangerous` | The user is always asked, an `allowAlways` grant is ignored, and the card carries the reason |
 * | `normal` | Exactly what S5.4 did |
 *
 * ## This is a guard rail, not a sandbox
 *
 * A determined model can defeat every rule below — `s=sudo; $s rm -rf /` is one
 * variable away, and a script the command runs is not read at all. That is fine,
 * because this is not the security boundary: the permission prompt is, and
 * `sandbox.ts` is what actually confines writes. What this module buys is that
 * the *common accidents* — a model that reaches for `sudo` out of habit, one
 * that types `rm -rf` with a path that resolved somewhere unexpected, one that
 * pipes a downloaded script into `sh` — either cannot happen or cannot be
 * approved by a grant given for something else. Do not read a `normal` verdict
 * as "this command is safe".
 *
 * ## Why it is pure
 *
 * No `node:fs`, no context, no electron: it takes the line plus the two
 * directories that decide what "outside" means, so the whole table below is a
 * unit test (CLAUDE.md rule #5). Paths are resolved lexically, deliberately —
 * a symlink is `paths.ts`'s problem and a classifier that hit the disk could not
 * answer for a folder that has been unmounted.
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import type { CommandRisk, CommandRiskReason, CommandVerdict } from '@shared/types'

export type { CommandRisk, CommandRiskReason, CommandVerdict }

/** The shell metacharacters that end one simple command and begin the next. */
const OPERATORS = ['&&', '||', ';;', ';', '|', '&'] as const

/** One simple command of a line: `git push origin main` inside `a && git push …`. */
export interface CommandSegment {
  /** The words of the command, quotes removed, in order. `[0]` is the program. */
  words: string[]
  /** Targets of redirections in this segment, which are files rather than arguments. */
  redirects: string[]
  /** True when this segment was suffixed with a bare `&`. */
  background: boolean
  /** True when this segment's output is piped into the next one. */
  pipedInto: boolean
}

/** What `tokenizeCommand` makes of one command line. */
export interface TokenizedCommand {
  segments: CommandSegment[]
  /** True when the line used `$(…)` or a backtick pair anywhere. */
  substitution: boolean
  /** True when any segment ended in a bare `&`. */
  background: boolean
}

/**
 * Splits a command line into simple commands.
 *
 * A real `sh` parser this is not, and it does not need to be: everything the
 * classifier asks is "which words are the program and its arguments", and the
 * three things that would make that question wrong are quoting (`echo "sudo"` is
 * not privilege escalation), operators (`ls; sudo rm` is two commands, and the
 * second one matters) and redirections (`> out.txt` is not an argument of `cat`).
 *
 * Command substitution is **recorded, not parsed**. `$(curl …)` runs a whole
 * second command line whose text this function would have to classify too, and
 * a classifier that got that nesting subtly wrong would be worse than one that
 * says "a command that computes part of itself is always worth asking about".
 * So the marker is set and the substitution's own text is dropped.
 */
export function tokenizeCommand(line: string): TokenizedCommand {
  const segments: CommandSegment[] = []
  let words: string[] = []
  let redirects: string[] = []
  let current = ''
  let hasCurrent = false
  let substitution = false
  let background = false
  /** Set when the previous token was a redirection operator. */
  let redirecting = false

  const pushWord = (): void => {
    if (!hasCurrent) return
    if (redirecting) redirects.push(current)
    else words.push(current)
    current = ''
    hasCurrent = false
    redirecting = false
  }

  const pushSegment = (options: { background?: boolean; pipedInto?: boolean } = {}): void => {
    pushWord()
    if (words.length === 0 && redirects.length === 0) return
    segments.push({
      words,
      redirects,
      background: options.background === true,
      pipedInto: options.pipedInto === true
    })
    words = []
    redirects = []
  }

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string

    if (char === '\\' && index + 1 < line.length) {
      current += line[index + 1] as string
      hasCurrent = true
      index += 1
      continue
    }

    // Single quotes are literal all the way to the next one; double quotes still
    // expand, which only matters here for `$(` — a `"$(id)"` is a substitution.
    if (char === "'" || char === '"') {
      const quote = char
      hasCurrent = true
      index += 1
      for (; index < line.length; index += 1) {
        const inner = line[index] as string
        if (inner === '\\' && quote === '"' && index + 1 < line.length) {
          current += line[index + 1] as string
          index += 1
          continue
        }
        if (inner === quote) break
        if (quote === '"' && inner === '$' && line[index + 1] === '(') substitution = true
        current += inner
      }
      continue
    }

    if (char === '`') {
      substitution = true
      // Skip to the closing backtick; its contents are not classified.
      const end = line.indexOf('`', index + 1)
      index = end === -1 ? line.length : end
      hasCurrent = true
      continue
    }

    if (char === '$' && line[index + 1] === '(') {
      substitution = true
      // Skip the balanced `$( … )` so its words are not read as this command's.
      let depth = 0
      for (; index < line.length; index += 1) {
        const inner = line[index] as string
        if (inner === '(') depth += 1
        else if (inner === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      hasCurrent = true
      continue
    }

    if (char === ' ' || char === '\t' || char === '\n') {
      pushWord()
      continue
    }

    // Redirections, consumed as whole operators rather than matched character by
    // character. `2>&1` is one token and must not be read as "redirect, then a
    // background `&`" — that mistake would make every stderr-merging command
    // look like a background process.
    if (char === '>' || char === '<' || (char === '&' && line[index + 1] === '>')) {
      // A leading file descriptor (`2>`) belongs to the operator, not to the word.
      if (/^\d*$/.test(current)) {
        current = ''
        hasCurrent = false
      } else {
        pushWord()
      }
      let operator = char
      while (index + 1 < line.length) {
        const next = line[index + 1] as string
        const extended = operator + next
        if (['>>', '>&', '&>', '&>>', '<<', '<<<', '>>&'].includes(extended)) {
          operator = extended
          index += 1
          continue
        }
        break
      }
      redirecting = true
      continue
    }

    if (char === '(' || char === ')' || char === '{' || char === '}') {
      // Subshell and group braces are separators for our purposes: `:(){ :|:& };:`
      // has to break into words rather than becoming one unreadable token.
      pushWord()
      continue
    }

    const operator = OPERATORS.find((candidate) => line.startsWith(candidate, index))
    if (operator) {
      pushWord()
      pushSegment(operator === '&' ? { background: true } : operator === '|' ? { pipedInto: true } : {})
      if (operator === '&') background = true
      index += operator.length - 1
      continue
    }

    current += char
    hasCurrent = true
  }

  pushSegment()
  return { segments, substitution, background }
}

/** The directories a resolution is measured against. Injected so tests are pure. */
export interface CommandPolicyOptions {
  /** The chat's working directory. Everything outside it is "outside". */
  workdir: string
  /** The user's home; `~` and `$HOME` expand to it. Defaults to `os.homedir()`. */
  home?: string
}

/** A verdict with nothing to say. */
const NORMAL: CommandRisk = { verdict: 'normal', reason: null }

function risk(verdict: CommandVerdict, reason: CommandRiskReason): CommandRisk {
  return { verdict, reason }
}

/** Programs that run the rest of the line as somebody else. */
const PRIVILEGE_PROGRAMS = new Set(['sudo', 'su', 'doas', 'sudoedit', 'pkexec'])

/** Programs that write a filesystem or a device rather than a file. */
const DISK_PROGRAMS = new Set([
  'mkfs',
  'newfs',
  'fdisk',
  'gpt',
  'hdiutil',
  'asr',
  'nvram',
  'csrutil'
])

/** Programs that end the session for everyone. */
const SHUTDOWN_PROGRAMS = new Set(['shutdown', 'reboot', 'halt', 'poweroff'])

/** Package managers whose publish subcommand puts something on the internet. */
const PUBLISH_COMMANDS: Record<string, readonly string[]> = {
  npm: ['publish'],
  pnpm: ['publish'],
  yarn: ['publish'],
  bun: ['publish'],
  cargo: ['publish'],
  gem: ['push'],
  twine: ['upload'],
  poetry: ['publish'],
  flit: ['publish'],
  docker: ['push'],
  gh: ['release']
}

/** Downloaders whose output being piped into a shell is the classic install line. */
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'httpie', 'http'])

/** Shells a downloaded script would be piped into. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'python', 'python3', 'ruby', 'perl', 'node'])

/** `git` subcommands that rewrite history rather than adding to it. */
const HISTORY_REWRITES = new Set(['rebase', 'filter-branch', 'filter-repo', 'reflog'])

/** The last path segment of a program, so `/usr/bin/sudo` is still `sudo`. */
export function programName(word: string | undefined): string {
  if (typeof word !== 'string' || word.length === 0) return ''
  const slash = word.lastIndexOf('/')
  return slash === -1 ? word : word.slice(slash + 1)
}

/** True when a word is a flag rather than an operand. */
function isFlag(word: string): boolean {
  return word.startsWith('-') && word !== '-'
}

/** The single-letter flags of a cluster like `-rf`, plus long flags as whole words. */
function flagsOf(words: readonly string[]): Set<string> {
  const flags = new Set<string>()
  for (const word of words) {
    if (!isFlag(word)) continue
    if (word.startsWith('--')) {
      flags.add(word)
      continue
    }
    for (const letter of word.slice(1)) flags.add(letter)
  }
  return flags
}

/**
 * `word` expanded and resolved against the working directory, or `null` when it
 * is not a path at all.
 *
 * "Not a path at all" is the load-bearing half: `rm file.txt` must stay
 * `normal`, and it does because `file.txt` names nothing outside the folder —
 * while `rm ../file.txt` and `rm /etc/hosts` both resolve out of it. A bare word
 * with no separator is treated as a path *relative to the folder*, which is what
 * a shell would do, so it can never be outside.
 */
export function resolvePathWord(
  word: string,
  options: Required<CommandPolicyOptions>
): string | null {
  if (word.length === 0 || isFlag(word)) return null
  // `FOO=bar` is an assignment, not a path, even though it may contain a slash.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return null

  let expanded = word
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = options.home + expanded.slice(1)
  } else if (expanded === '$HOME' || expanded.startsWith('$HOME/')) {
    expanded = options.home + expanded.slice('$HOME'.length)
  } else if (expanded === '${HOME}' || expanded.startsWith('${HOME}/')) {
    expanded = options.home + expanded.slice('${HOME}'.length)
  }
  // A variable this module cannot expand makes every answer about the path a
  // guess; `outsideWorkdir` treats that as unknown rather than as outside.
  if (expanded.includes('$')) return null

  return isAbsolute(expanded) ? resolve(expanded) : resolve(options.workdir, expanded)
}

/** True when `target` is the working directory itself or lives underneath it. */
function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * How bad a path operand is: the root of the disk and the home directory are
 * their own class, because `rm -rf ~` is not "a delete outside the folder", it
 * is the one command this product must never run.
 */
type PathVerdict = 'inside' | 'outside' | 'catastrophic'

function judgePath(target: string, options: Required<CommandPolicyOptions>): PathVerdict {
  const root = resolve(options.workdir)
  const home = resolve(options.home)
  if (target === sep || target === home) return 'catastrophic'
  if (inside(root, target)) return 'inside'
  // A delete of something that *contains* the home directory is the same class.
  if (inside(target, home) || inside(target, root)) return 'catastrophic'
  return 'outside'
}

/** The operands of a segment, resolved; flags and assignments dropped. */
function operandPaths(
  segment: CommandSegment,
  options: Required<CommandPolicyOptions>,
  skip = 1
): string[] {
  const resolved: string[] = []
  for (const word of segment.words.slice(skip)) {
    const path = resolvePathWord(word, options)
    if (path !== null) resolved.push(path)
  }
  return resolved
}

/** The `rm -r` / `chmod -R` family: a recursive operation and where it points. */
function classifyRecursive(
  segment: CommandSegment,
  options: Required<CommandPolicyOptions>
): CommandRisk | null {
  const program = programName(segment.words[0])
  const flags = flagsOf(segment.words)

  if (program === 'rm') {
    const recursive = flags.has('r') || flags.has('R') || flags.has('--recursive')
    const targets = operandPaths(segment, options)
    const worst = targets.map((target) => judgePath(target, options))
    if (worst.includes('catastrophic')) return risk('blocked', 'destructive-delete')
    if (recursive && worst.includes('outside')) return risk('blocked', 'destructive-delete')
    if (recursive) return risk('dangerous', 'recursive-delete')
    if (worst.includes('outside')) return risk('dangerous', 'outside-workdir')
    return null
  }

  if (program === 'chmod' || program === 'chown' || program === 'chgrp') {
    const recursive = flags.has('R') || flags.has('--recursive')
    if (!recursive) return null
    // The first operand of `chmod` is a mode, of `chown` an owner: neither is a
    // path, and both are dropped by `resolvePathWord` only by accident, so the
    // judgement runs over every operand and takes the worst.
    const worst = operandPaths(segment, options).map((target) => judgePath(target, options))
    if (worst.includes('catastrophic') || worst.includes('outside')) {
      return risk('blocked', 'destructive-permissions')
    }
    return null
  }

  return null
}

/** `dd of=/dev/disk2`, `diskutil eraseDisk`, `mkfs …`: writes that are not files. */
function classifyDisk(segment: CommandSegment): CommandRisk | null {
  const program = programName(segment.words[0])

  if (DISK_PROGRAMS.has(program) || program.startsWith('mkfs.')) {
    return risk('blocked', 'disk-write')
  }

  if (program === 'dd') {
    const writesDevice = segment.words.some(
      (word) => word.startsWith('of=/dev/') && word !== 'of=/dev/null'
    )
    if (writesDevice) return risk('blocked', 'disk-write')
    return null
  }

  if (program === 'diskutil') {
    const verb = (segment.words[1] ?? '').toLowerCase()
    if (verb.startsWith('erase') || verb === 'partitiondisk' || verb === 'reformat') {
      return risk('blocked', 'disk-write')
    }
    return null
  }

  return null
}

/** `git` is the one program whose *subcommand* decides everything. */
function classifyGit(segment: CommandSegment): CommandRisk | null {
  if (programName(segment.words[0]) !== 'git') return null

  // `git -C dir push` — skip the global options to find the subcommand.
  const rest = segment.words.slice(1)
  let index = 0
  while (index < rest.length && isFlag(rest[index] as string)) {
    // `-C` and `-c` take a value; the rest of git's global flags do not.
    if (rest[index] === '-C' || rest[index] === '-c') index += 1
    index += 1
  }
  const subcommand = rest[index]
  const args = rest.slice(index + 1)
  if (typeof subcommand !== 'string') return null

  if (subcommand === 'push') {
    const forced = args.some((word) => word === '-f' || word.startsWith('--force'))
    return risk('dangerous', forced ? 'history-rewrite' : 'git-push')
  }
  if (subcommand === 'reset' && args.some((word) => word === '--hard')) {
    return risk('dangerous', 'git-reset-hard')
  }
  if (subcommand === 'clean') return risk('dangerous', 'git-clean')
  if (HISTORY_REWRITES.has(subcommand)) return risk('dangerous', 'history-rewrite')
  if (subcommand === 'commit' && args.some((word) => word === '--amend')) {
    return risk('dangerous', 'history-rewrite')
  }
  if (subcommand === 'branch' && args.some((word) => word === '-D' || word === '--delete')) {
    return risk('dangerous', 'history-rewrite')
  }
  return null
}

/** `npm publish`, `cargo publish`, `docker push`: putting something on the internet. */
function classifyPublish(segment: CommandSegment): CommandRisk | null {
  const program = programName(segment.words[0])
  const verbs = PUBLISH_COMMANDS[program]
  if (!verbs) return null
  const subcommand = segment.words.slice(1).find((word) => !isFlag(word))
  if (subcommand !== undefined && verbs.includes(subcommand)) {
    return risk('dangerous', 'package-publish')
  }
  return null
}

/**
 * `:(){ :|:& };:` and its relatives.
 *
 * Matched on the raw line rather than on tokens, because the whole point of a
 * fork bomb is that it is punctuation: by the time it has been split into words
 * there is nothing recognisable left.
 */
function classifyForkBomb(line: string): CommandRisk | null {
  const squeezed = line.replace(/\s+/g, '')
  if (/:\(\)\{:\|:&\};:/.test(squeezed)) return risk('blocked', 'fork-bomb')
  // `while true; do … & done` with nothing between the `do` and the `&`.
  if (/while(true|:);?do[^;]*&done/.test(squeezed)) return risk('blocked', 'fork-bomb')
  return null
}

/** The worse of two verdicts, `blocked` > `dangerous` > `normal`. */
const ORDER: Record<CommandVerdict, number> = { normal: 0, dangerous: 1, blocked: 2 }

function worse(left: CommandRisk, right: CommandRisk): CommandRisk {
  return ORDER[right.verdict] > ORDER[left.verdict] ? right : left
}

/**
 * Classifies one command line.
 *
 * The verdict is the **worst** of every segment's, because a line is only as
 * safe as the most dangerous command in it: `npm test && git push` is a push.
 * The first reason at that level wins, so the message names the rule that
 * decided rather than the last one that matched.
 */
export function classifyCommand(line: string, options: CommandPolicyOptions): CommandRisk {
  const resolved: Required<CommandPolicyOptions> = {
    workdir: resolve(options.workdir),
    home: resolve(options.home ?? homedir())
  }

  const bomb = classifyForkBomb(line)
  if (bomb) return bomb

  const tokens = tokenizeCommand(line)
  let verdict: CommandRisk = NORMAL

  for (let index = 0; index < tokens.segments.length; index += 1) {
    const segment = tokens.segments[index] as CommandSegment
    if (segment.words.length === 0) continue
    const program = programName(segment.words[0])

    if (PRIVILEGE_PROGRAMS.has(program)) {
      return risk('blocked', 'privilege-escalation')
    }
    if (SHUTDOWN_PROGRAMS.has(program)) {
      return risk('blocked', 'shutdown')
    }

    for (const rule of [classifyDisk(segment), classifyRecursive(segment, resolved)]) {
      if (rule?.verdict === 'blocked') return rule
      if (rule) verdict = worse(verdict, rule)
    }

    for (const rule of [classifyGit(segment), classifyPublish(segment)]) {
      if (rule) verdict = worse(verdict, rule)
    }

    // A downloader whose output is piped into an interpreter. The pipe is the
    // whole rule: `curl -O https://…` writes a file and is ordinary.
    if (segment.pipedInto && DOWNLOADERS.has(program)) {
      const next = tokens.segments[index + 1]
      if (next && SHELLS.has(programName(next.words[0]))) {
        verdict = worse(verdict, risk('dangerous', 'download-to-shell'))
      }
    }

    if (segment.background) {
      verdict = worse(verdict, risk('dangerous', 'background-process'))
    }
    if (program === 'nohup' || program === 'disown' || program === 'launchctl') {
      verdict = worse(verdict, risk('dangerous', 'background-process'))
    }

    // Anything else that names a path outside the folder — including a
    // redirection target, which is a write this policy would otherwise miss.
    const outside = [...operandPaths(segment, resolved), ...segment.redirects.flatMap((target) => {
      const path = resolvePathWord(target, resolved)
      return path === null ? [] : [path]
    })].some((target) => judgePath(target, resolved) !== 'inside')
    if (outside) verdict = worse(verdict, risk('dangerous', 'outside-workdir'))
  }

  if (tokens.substitution) {
    verdict = worse(verdict, risk('dangerous', 'command-substitution'))
  }

  return verdict
}

/**
 * The sentence a blocked command comes back to the model as.
 *
 * Model-facing English, not an i18n key, exactly like `PermissionDeniedError`:
 * it is prompt content the executor has to be able to reason about and talk
 * about, not UI copy the renderer translates (CLAUDE.md rule #4 governs the
 * latter). The user sees the same fact as the failed tool card.
 */
export function blockedCommandMessage(reason: CommandRiskReason): string {
  const detail: Record<CommandRiskReason, string> = {
    'privilege-escalation': 'it asks for root privileges',
    'disk-write': 'it writes a disk or a device rather than a file',
    shutdown: 'it shuts the machine down',
    'fork-bomb': 'it is a fork bomb',
    'destructive-delete': 'it recursively deletes something outside the working directory',
    'destructive-permissions':
      'it recursively changes permissions or ownership outside the working directory',
    'recursive-delete': 'it deletes a directory tree',
    'git-push': 'it publishes commits',
    'git-reset-hard': 'it discards the working tree',
    'git-clean': 'it deletes untracked files',
    'history-rewrite': 'it rewrites history',
    'package-publish': 'it publishes a package',
    'download-to-shell': 'it pipes a download into a shell',
    'command-substitution': 'it computes part of itself with another command',
    'outside-workdir': 'it names a path outside the working directory',
    'background-process': 'it leaves a process running in the background'
  }
  return (
    `That command was refused before it ran because ${detail[reason]}. ` +
    'This is a hard limit and the user was not asked; do not try to work around it. ' +
    'Say what you wanted to achieve and ask the user to do it themselves if it is really needed.'
  )
}
