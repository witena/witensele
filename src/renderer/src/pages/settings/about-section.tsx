/**
 * Settings → About (S7.5): which version this is, where it comes from, and what
 * it is built on.
 *
 * Three blocks, and each answers a question someone actually asks:
 *
 * - **The version**, because a bug report without one is unanswerable. It is
 *   `APP_VERSION` from `@shared/version`, which `scripts/sync-version.mjs`
 *   keeps equal to `package.json` and `src/main/packaging.test.ts` checks.
 * - **The repository**, as a real link. A `target="_blank"` link in Electron is
 *   caught by the `setWindowOpenHandler` in `src/main/index.ts`, which hands
 *   http(s) to the system browser and denies everything else — the same path a
 *   link inside a message body takes. The URL is printed as well as linked, so
 *   it can be read or copied by someone who will not click it.
 * - **The licences of the bundled dependencies**, generated rather than
 *   maintained: see `lib/licenses.ts` and `scripts/generate-licenses.mjs`.
 *
 * The list leads with the counts per licence, because "is there anything
 * unusual in here?" is the question, and 244 rows do not answer it. The rows
 * themselves are below it in one scrolling block; a package's name and version
 * are data and are printed, never translated.
 */
import { useTranslation } from 'react-i18next'
import { APP_NAME, APP_REPOSITORY_URL, APP_VERSION } from '@shared/version'
import { SectionTitle } from '../../components/ui'
import { BUNDLED_LICENSES, licenseSummary } from '../../lib/licenses'

export function AboutSection(): React.JSX.Element {
  const { t } = useTranslation()
  const summary = licenseSummary()

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <SectionTitle level={3}>{t('settings.about.version')}</SectionTitle>
        {/* Name and version are data: the product is called Witena in every
            language and `0.1.0` is not a sentence. */}
        <p data-testid="about-version" className="font-mono text-xs text-fg">
          {`${APP_NAME} ${APP_VERSION}`}
        </p>
        <p className="text-[11px] leading-relaxed text-fg-faint">
          {t('settings.about.versionHint')}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionTitle level={3}>{t('settings.about.repository')}</SectionTitle>
        <a
          data-testid="about-repository"
          href={APP_REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
          className="w-fit rounded font-mono text-xs text-accent hover:text-accent-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {APP_REPOSITORY_URL}
        </a>
        <p className="text-[11px] leading-relaxed text-fg-faint">
          {t('settings.about.repositoryHint')}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle level={3}>{t('settings.about.licenses')}</SectionTitle>
        <p
          data-testid="about-licenses-count"
          data-count={BUNDLED_LICENSES.length}
          className="text-[11px] leading-relaxed text-fg-faint"
        >
          {t('settings.about.licensesHint', { packages: BUNDLED_LICENSES.length })}
        </p>

        <ul className="flex flex-wrap gap-1.5">
          {summary.map((entry) => (
            <li
              key={entry.license}
              data-testid="about-license-summary"
              className="rounded-md border border-border-strong bg-bg-elevated px-2 py-0.5 font-mono text-[11px] text-fg-muted"
            >
              {`${entry.license} · ${entry.count}`}
            </li>
          ))}
        </ul>

        <ul
          data-testid="about-licenses"
          className="max-h-72 overflow-y-auto rounded-lg border border-border-strong bg-bg-base px-3 py-2"
        >
          {BUNDLED_LICENSES.map((entry) => (
            <li
              key={entry.name}
              data-testid="about-license-row"
              className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-b-0"
            >
              <span className="min-w-0 truncate font-mono text-[11px] text-fg-secondary">
                {`${entry.name}@${entry.version}`}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-fg-faint">{entry.license}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
