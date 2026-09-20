/**
 * `integrations.*` — the local MCP endpoint and the coding agents pointed at it
 * (S10.4).
 *
 * Three methods, and the whole of what Settings → Integrations does. The
 * knowledge they hold is the *policy*; the CLI forms are
 * `../integrations/ide-clients.ts` and the listening socket is
 * `../mcp-endpoint/host.ts`, so this file is the only place that decides what
 * "connected", "stale" and "connect" mean.
 *
 * Four rules are worth stating, because each of them is a decision and not an
 * implementation detail:
 *
 * 1. **Connecting opens the door.** `connect` enables `mcpEndpoint` through the
 *    `settings.update` handler before it registers anything. An IDE pointed at a
 *    closed door is never what the button meant, and doing it through the
 *    handler rather than the repository is what starts the host: the toggle's
 *    side effect lives there and is idempotent (S10.3).
 * 2. **`enabled` and `listening` are reported separately.** The row is the
 *    user's intent; `ctx.mcpEndpoint?.state` is what this process is doing.
 *    `ctx.mcpEndpoint` is `null` on the Node host and in every test, where the
 *    setting is stored and nothing listens, and a single "on" would have to lie
 *    about one of the two.
 * 3. **`connect` repairs.** A client registered with a command that is not this
 *    installation's launcher is unregistered and registered again, so the
 *    section's "Repair" is the same call as its "Connect" and cannot drift from
 *    it. A client already registered with the right command is left untouched —
 *    re-running `mcp add` over an existing name is the clients' error case, not
 *    an update.
 * 4. **`status` never rejects for a state.** Not installed, not connected,
 *    endpoint off: the section has to draw all three, so each is a value. The
 *    two refusals are things a button genuinely cannot do — there is no launcher
 *    to register, or there is no CLI to register it with — and both carry a
 *    `ValidationReason` so the renderer writes the sentence (CLAUDE.md rule #4).
 */
import type { IdeClientId, IdeClientStatus, IntegrationStatus } from '@shared/types'
import { IDE_CLIENT_IDS } from '@shared/types'
import type { AppContext } from '../app-context'
import { validation } from '../errors'
import { isIdeClientId } from '../integrations/ide-clients'
import { settingsHandlers } from './settings'
import type { HandlerMap, HandlerModule } from './types'

/**
 * `settings.update`, reached as a function rather than through the built map.
 *
 * `buildHandlers()` takes no context and is assembled *from* this module, so
 * asking it for a sibling would be a cycle. The cast is the narrowing the
 * `HandlerModule` type cannot do on its own — `settings.ts` defines the method
 * unconditionally, two lines above — and it is preferred to a second copy of the
 * toggle's side effect, which is the whole reason the endpoint is enabled
 * through the handler at all.
 */
const updateSettings = settingsHandlers['settings.update'] as HandlerMap['settings.update']

/** The client id out of an input a renderer or a test sent. */
function readClientId(input: unknown): IdeClientId {
  const client = (input as { client?: unknown } | undefined)?.client
  if (!isIdeClientId(client)) {
    throw validation(
      `integrations: unknown client ${String(client)} (expected ${IDE_CLIENT_IDS.join(', ')})`
    )
  }
  return client
}

/**
 * One client's three facts, asked of the CLI in the cheapest order.
 *
 * `registered` is only asked of a client that answered `--version`, because
 * every read is a child process and a machine without Codex must not pay for one
 * on every mount of the settings page.
 */
async function clientStatus(
  ctx: AppContext,
  id: IdeClientId,
  launcherPath: string | null
): Promise<IdeClientStatus> {
  const installed = await ctx.ideClients.detect(id)
  if (!installed) return { id, installed: false, connected: false, stale: false }

  const command = await ctx.ideClients.registered(id)
  if (command === null) return { id, installed: true, connected: false, stale: false }

  return {
    id,
    installed: true,
    connected: true,
    command,
    // A build that ships no launcher has nothing to compare against, and calling
    // a hand-written development command "stale" would offer a Repair that could
    // only fail. Unknown is reported as not stale.
    stale: launcherPath !== null && command !== launcherPath
  }
}

/** The whole picture, as `integrations.status` answers it. */
async function readStatus(ctx: AppContext): Promise<IntegrationStatus> {
  const launcherPath = ctx.mcpLauncherPath
  const enabled = ctx.repos.settings.get(ctx.userId).mcpEndpoint.enabled
  const state = ctx.mcpEndpoint?.state

  const clients: IdeClientStatus[] = []
  for (const id of IDE_CLIENT_IDS) {
    clients.push(await clientStatus(ctx, id, launcherPath))
  }

  return {
    endpoint: {
      enabled,
      listening: state?.listening === true,
      ...(state?.listening === true ? { port: state.port } : {})
    },
    launcherPath,
    clients
  }
}

export const integrationsHandlers: HandlerModule = {
  'integrations.status': async (ctx) => await readStatus(ctx),

  'integrations.connect': async (ctx, input) => {
    const client = readClientId(input)
    const launcherPath = ctx.mcpLauncherPath
    if (launcherPath === null) {
      throw validation(
        'integrations.connect: this build ships no MCP launcher, so there is no command to register',
        { reason: 'integrations_no_launcher' }
      )
    }
    if (!(await ctx.ideClients.detect(client))) {
      throw validation(`integrations.connect: ${client} is not installed on this machine`, {
        reason: 'integrations_client_not_installed',
        client
      })
    }

    // Before the registration, not after: a client that is told about the
    // launcher while the endpoint is shut is a client whose next tool call
    // fails. The toggle is idempotent, so connecting a second client is free.
    await updateSettings(ctx, { patch: { mcpEndpoint: { enabled: true } } })

    const current = await ctx.ideClients.registered(client)
    if (current !== launcherPath) {
      // `mcp add` over a name that already exists is an error in both CLIs, so a
      // repair is a removal and an addition rather than an overwrite.
      if (current !== null) await ctx.ideClients.unregister(client)
      await ctx.ideClients.register(client, launcherPath)
    }

    return await readStatus(ctx)
  },

  'integrations.disconnect': async (ctx, input) => {
    const client = readClientId(input)
    if (!(await ctx.ideClients.detect(client))) {
      throw validation(`integrations.disconnect: ${client} is not installed on this machine`, {
        reason: 'integrations_client_not_installed',
        client
      })
    }

    // Idempotent: nothing registered is the state the caller asked for. The
    // endpoint is deliberately left listening — another client, or a
    // hand-written configuration, may still be pointed at it, and the switch is
    // how the user closes the door.
    if ((await ctx.ideClients.registered(client)) !== null) {
      await ctx.ideClients.unregister(client)
    }

    return await readStatus(ctx)
  }
}
