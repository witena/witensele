/**
 * Turns the frames `e2e/demo.record.ts` filmed into the README's media.
 *
 * The recorder leaves one JPEG per change of the picture plus
 * `recording.json`, which carries every frame's timestamp and the sections the
 * tour `mark()`ed. This script replays them through ffmpeg's concat demuxer,
 * holding each frame for as long as it was on screen, and writes:
 *
 * | Path | What it is |
 * |---|---|
 * | `docs/assets/demo.mp4` | The whole tour, 1440 x 900, H.264 |
 * | `docs/assets/demo.gif` | The whole tour, 1120 px wide, 12 fps — the README's hero |
 * | `docs/assets/features/<section>.gif` | One clip per `mark()`ed section, 800 px wide, 10 fps — the README's feature wall |
 *
 * A frame is never held longer than `MAX_HOLD` seconds. The screencast only
 * delivers a frame when something changes, so a long hold is a model thinking
 * or a connection test waiting — dead air that made the previous recording a
 * minute long and its GIF seven megabytes.
 *
 * Every GIF is two-pass (`palettegen` then `paletteuse`) over the same filtered
 * frames, so the palette describes what is actually encoded.
 *
 * Usage: `npm run demo` films, then `node scripts/render-demo.mjs` renders.
 * `WITENA_DEMO_DIR` moves the input directory, as it does for the recorder.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const inputDir = process.env['WITENA_DEMO_DIR'] ?? join(root, 'test-results', 'demo')
const assetsDir = join(root, 'docs', 'assets')
const featuresDir = join(assetsDir, 'features')

/** The longest any single frame stays on screen, in seconds. */
const MAX_HOLD = 1.2

/** How long the last frame of a clip is held, so a loop does not snap back mid-read. */
const FINAL_HOLD = 2

const recordingFile = join(inputDir, 'recording.json')
if (!existsSync(recordingFile)) {
  throw new Error(`${recordingFile} is missing. Run "npm run demo" first.`)
}
const { frames, sections } = JSON.parse(readFileSync(recordingFile, 'utf8'))

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit'
  })
}

/**
 * Writes an ffconcat list for the frames on screen between `start` and `end`.
 * The frame already showing at `start` is included, so a clip opens on the
 * picture the section began with rather than on its first change.
 */
function writeList(name, start, end) {
  const first = Math.max(0, frames.findLastIndex((frame) => frame.time <= start))
  const shown = frames.slice(first).filter((frame) => frame.time <= end)
  if (shown.length === 0) throw new Error(`No frames between ${start} and ${end} (${name})`)

  const lines = ['ffconcat version 1.0']
  shown.forEach((frame, index) => {
    const next = shown[index + 1]
    const hold = next ? Math.min(next.time - Math.max(frame.time, start), MAX_HOLD) : FINAL_HOLD
    lines.push(`file '${join(inputDir, 'frames', frame.file)}'`, `duration ${hold.toFixed(3)}`)
  })
  // The concat demuxer ignores the last `duration` unless the file is repeated.
  lines.push(`file '${join(inputDir, 'frames', shown.at(-1).file)}'`)

  const list = join(inputDir, `${name}.ffconcat`)
  writeFileSync(list, `${lines.join('\n')}\n`)
  return list
}

function renderGif(list, output, { width, fps, colors }) {
  const pre = `fps=${fps},scale=${width}:-1:flags=lanczos`
  const palette = join(inputDir, 'palette.png')
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `${pre},palettegen=max_colors=${colors}:stats_mode=diff`,
    palette
  ])
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', list, '-i', palette,
    '-lavfi', `${pre}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    output
  ])
}

rmSync(featuresDir, { recursive: true, force: true })
mkdirSync(featuresDir, { recursive: true })

const whole = writeList('demo', frames[0].time, frames.at(-1).time)
ffmpeg([
  '-f', 'concat', '-safe', '0', '-i', whole,
  '-vf', 'fps=30,scale=1440:-2:flags=lanczos,format=yuv420p',
  '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart',
  join(assetsDir, 'demo.mp4')
])
renderGif(whole, join(assetsDir, 'demo.gif'), { width: 1120, fps: 12, colors: 48 })
console.log('docs/assets/demo.mp4, docs/assets/demo.gif')

for (const section of sections) {
  const list = writeList(section.name, section.start, section.end)
  renderGif(list, join(featuresDir, `${section.name}.gif`), { width: 800, fps: 10, colors: 48 })
  console.log(`docs/assets/features/${section.name}.gif`)
}
