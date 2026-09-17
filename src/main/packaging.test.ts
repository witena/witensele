/**
 * The release manifest: what `.github/workflows/release.yml` will build when a
 * `v*` tag is pushed (S7.2).
 *
 * The subject is a YAML file rather than a module, so this asserts only the
 * facts something else depends on and a careless edit could silently drop: both
 * architectures, the publish feed, an artifact name that keeps the two dmgs
 * apart, and — since S7.3 — the signing shape, because every one of those
 * options is invisible until a certificate exists and a wrong one then fails on
 * a release rather than on a laptop. Everything else about the bundle — asar
 * unpacking, extra resources, the icon — is proven by a real build, which is
 * what `e2e/packaged.spec.ts` is for.
 *
 * What it cannot assert is the part that needs Apple: that the signature is
 * accepted, that notarization returns a ticket, and that the hardened runtime
 * lets `better_sqlite3.node` load. Those wait for the first signed build.
 *
 * The YAML is parsed with `gray-matter`, the frontmatter parser the skills
 * loader already depends on: wrapping the document in `---` delimiters hands it
 * to the same js-yaml gray-matter carries, which is cheaper than a dependency
 * added for one test.
 *
 * It lives under `src/main/` rather than beside the version constant it checks
 * because `src/shared/` is compiled by `tsconfig.web.json` too, and that project
 * has no `@types/node` — `node:fs` does not resolve there. Nothing here imports
 * electron (CLAUDE.md rule 5); it reads two files off disk.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '@shared/version'
import { SIGNED_BUILD_FIELD } from './secrets'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The entitlements file, named once because three assertions depend on it. */
const ENTITLEMENTS = 'build/entitlements.mac.plist'

function readYaml(relativePath: string): Record<string, unknown> {
  const text = readFileSync(join(repoRoot, relativePath), 'utf8')
  return matter(`---\n${text}\n---\n`).data
}

function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>
}

interface MacTarget {
  target: string
  arch: string[]
}

describe('electron-builder.yml', () => {
  const config = readYaml('electron-builder.yml')
  const mac = config['mac'] as Record<string, unknown> & { target: MacTarget[] }

  it('builds a dmg for both macOS architectures', () => {
    // Two dmgs rather than a universal binary: PLAN.md, "Local release".
    expect(mac.target).toHaveLength(1)
    expect(mac.target[0]?.target).toBe('dmg')
    expect(mac.target[0]?.arch).toEqual(['arm64', 'x64'])
  })

  it('names the artifacts so the two architectures cannot collide', () => {
    const dmg = config['dmg'] as { artifactName: string }
    expect(dmg.artifactName).toContain('${arch}')
    expect(dmg.artifactName).toContain('${version}')
  })

  it('publishes draft GitHub Releases', () => {
    // A draft is what makes a tag safe: CI packages, a human publishes.
    const publish = config['publish'] as { provider: string; releaseType: string }
    expect(publish.provider).toBe('github')
    expect(publish.releaseType).toBe('draft')
  })

  it('signs with whatever Developer ID the keychain holds, and skips when it holds none (S7.3)', () => {
    // `identity: null` meant "never sign" and was right while no certificate
    // existed. Its **absence** is what makes the same configuration produce a
    // signed build on a machine that has a Developer ID and the unsigned build
    // this repository shipped before on one that does not — electron-builder
    // looks the identity up and logs "skipped macOS application code signing"
    // when the lookup comes back empty. An `identity` key of any value here,
    // including null, would break one of those two halves.
    expect(mac).not.toHaveProperty('identity')
  })

  it('hardens the runtime and ships the entitlements notarization requires (S7.3)', () => {
    const signing = mac as unknown as {
      hardenedRuntime: boolean
      gatekeeperAssess: boolean
      entitlements: string
      entitlementsInherit: string
      notarize: boolean
    }

    // Notarization refuses a bundle that is not hardened.
    expect(signing.hardenedRuntime).toBe(true)
    // `spctl --assess` during packaging fails on a correctly signed bundle that
    // has not been notarized yet, which is every bundle at the moment it exists.
    expect(signing.gatekeeperAssess).toBe(false)
    // A boolean in electron-builder 26: the credentials live in the environment
    // (APPLE_KEYCHAIN_PROFILE locally, APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD +
    // APPLE_TEAM_ID in CI) and never in a file in this repository.
    expect(signing.notarize).toBe(true)

    expect(signing.entitlements).toBe(ENTITLEMENTS)
    expect(signing.entitlementsInherit).toBe(ENTITLEMENTS)
  })
})

describe('the hardened runtime entitlements', () => {
  const plist = readFileSync(join(repoRoot, ENTITLEMENTS), 'utf8')

  // The `<key>` elements, which is what `codesign` acts on. Read rather than
  // searched for: the file's own comment names `disable-library-validation` in
  // order to explain why it is absent, and a substring search over the whole
  // document would find that sentence and call it a grant.
  const granted = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])

  it('grants V8 what the hardened runtime otherwise refuses it', () => {
    // Without these two Electron does not start under the hardened runtime:
    // V8 compiles to machine code at runtime and writes into the pages it then
    // executes. They are named by @electron/notarize's own prerequisites.
    expect(granted).toContain('com.apple.security.cs.allow-jit')
    expect(granted).toContain('com.apple.security.cs.allow-unsigned-executable-memory')

    // Every value is a grant; a `<false/>` would be a key that reads as present
    // and does nothing.
    expect(plist).not.toContain('<false/>')
  })

  it('grants nothing else, including library validation', () => {
    // `disable-library-validation` is in electron-builder's default template and
    // is deliberately **not** here: the one native library Witena dlopens
    // (`better_sqlite3.node`) is signed by this build with this project's own
    // identity, because @electron/osx-sign signs every Mach-O under `Contents/`,
    // so same-team validation passes and the exception would only widen what the
    // app is allowed to load. Reasoning, not observation — it cannot be proven
    // until a real certificate signs a build (STEPS.md S7.3). The file says what
    // to do if the first signed build disagrees.
    //
    // Nothing device- or location-related either: @electron/osx-sign's own
    // default file asks for six such entitlements and Witena uses none of them,
    // and an entitlement that is requested but unused is a permission prompt
    // waiting to surprise somebody.
    expect(granted).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory'
    ])
  })
})

describe('the signed-build flag', () => {
  const scripts = manifest()['scripts'] as Record<string, string>

  it('is passed by `dist:signed` and by nothing else', () => {
    // `extraMetadata` writes the field into the `package.json` **inside** the
    // bundle, which is the only copy the launched application can read; an
    // environment variable exported while building reaches nothing (S7.6's
    // recorded gap). `src/main/index.ts` reads it back through
    // `app.getAppPath()`.
    expect(scripts['dist:signed']).toContain(`-c.extraMetadata.${SIGNED_BUILD_FIELD}=true`)

    // The ordinary build must not claim to be signed: the flag turns on
    // Keychain wrapping of the key file, and doing that on an unsigned build is
    // exactly the bug S7.6 fixed.
    expect(scripts['dist']).not.toContain(SIGNED_BUILD_FIELD)
    expect(scripts['dist:dir']).not.toContain(SIGNED_BUILD_FIELD)
  })

  it('is absent from the repository manifest, so a checkout is never signed', () => {
    expect(manifest()).not.toHaveProperty(SIGNED_BUILD_FIELD)
  })
})

describe('the released version number', () => {
  it('matches package.json, which `npm version` bumps', () => {
    // `scripts/sync-version.mjs` runs in npm's `version` lifecycle and keeps
    // these two equal; this test is what notices when it does not.
    expect(APP_VERSION).toBe(manifest()['version'])
  })
})
