/**
 * Settings → Skills: the 520px card list and the detail pane beside it.
 *
 * The same two-column shape as Providers and MCP servers, and for the same
 * reason — the section owns its columns, so `SettingsPage` renders it in place
 * of the generic pane and the list header carries
 * `data-testid="settings-section-title"`.
 *
 * ## Why the right column is a reader, not an editor
 *
 * A skill is a folder the user wrote or downloaded. The app's job is to show
 * exactly what the agent will be given — the description that goes in the
 * prompt, the body `read_skill` returns, and the files `read_skill_file` can
 * reach — not to become a markdown editor for content that lives on disk and is
 * versioned by whatever wrote it. So the pane renders the body with the same
 * `Markdown` component the transcript uses and lists the bundled files, and the
 * only two actions are Import and Delete.
 *
 * ## Import needs a native dialog
 *
 * "Import folder" calls `system.pickFolder`, the one backend method implemented
 * in `src/main/ipc/` because it needs a window (see `shared/backend.ts`). The
 * store handles a cancelled dialog as a non-event; a refused import — a folder
 * with no `SKILL.md`, or a name already taken — lands in `error` and is shown
 * under the button.
 */
import { FolderPlus, Sparkles } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SkillWarning } from '@shared/types'
import { Column } from '../../components/layout/column'
import { PageHeader } from '../../components/layout/page-header'
import { Markdown } from '../../components/chat/markdown'
import { SkillCard } from '../../components/settings/skill-card'
import { Badge, Button, EmptyState, SectionTitle, Spinner } from '../../components/ui'
import { translateError } from '../../i18n/errors'
import { useSkillsStore } from '../../stores/skills'

/** Literal `t()` calls, so `used-keys.test.ts` can verify every reason. */
function warningLabel(t: TFunction, warning: SkillWarning): string {
  switch (warning.reason) {
    case 'missing-description':
      return t('settings.skills.warningMissingDescription', { folder: warning.folder })
    case 'unreadable':
      return t('settings.skills.warningUnreadable', { folder: warning.folder })
  }
}

export function SkillsSection(): React.JSX.Element {
  const { t } = useTranslation()

  const skills = useSkillsStore((state) => state.skills)
  const warnings = useSkillsStore((state) => state.warnings)
  const status = useSkillsStore((state) => state.status)
  const error = useSkillsStore((state) => state.error)
  const errorCode = useSkillsStore((state) => state.errorCode)
  const selectedName = useSkillsStore((state) => state.selectedName)
  const detail = useSkillsStore((state) => state.detail)
  const importing = useSkillsStore((state) => state.importing)

  /** Delete is armed by the first click and fires on the second. */
  const [deleteArmed, setDeleteArmed] = useState(false)

  useEffect(() => {
    void useSkillsStore.getState().load()
  }, [])

  // Selecting another skill must never leave a live "click again to confirm" on
  // the new one.
  useEffect(() => {
    setDeleteArmed(false)
  }, [selectedName])

  const importButton = (testId?: string): React.JSX.Element => (
    <Button
      variant="primary"
      data-testid={testId}
      disabled={importing}
      onClick={() => void useSkillsStore.getState().importFolder()}
    >
      <FolderPlus aria-hidden="true" strokeWidth={2.2} className="h-3.5 w-3.5" />
      {importing ? t('settings.skills.importing') : t('settings.skills.import')}
    </Button>
  )

  return (
    <>
      <Column width={520} className="bg-bg-panel">
        <PageHeader
          testId="settings-section-title"
          title={t('settings.sections.skills')}
          badge={<span className="text-sm font-normal text-fg-faint">{skills.length}</span>}
          actions={importButton('skills-import')}
        />

        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-5 py-4">
          <p className="px-1 text-[11px] leading-relaxed text-fg-faint">
            {t('settings.skills.intro')}
          </p>

          {skills.map((skill) => (
            <SkillCard
              key={skill.folder}
              skill={skill}
              selected={skill.name === selectedName}
              filesLabel={
                skill.fileCount > 0
                  ? t('settings.skills.fileCount', { files: skill.fileCount })
                  : undefined
              }
              onSelect={() => void useSkillsStore.getState().select(skill.name)}
            />
          ))}

          {skills.length === 0 && status !== 'loading' ? (
            <EmptyState
              icon={Sparkles}
              title={t('settings.skills.emptyTitle')}
              description={t('settings.skills.emptyDescription')}
              action={importButton()}
            />
          ) : null}

          {warnings.map((warning) => (
            <p
              key={warning.folder}
              data-testid="skill-warning"
              className="px-1 text-[11px] leading-relaxed text-status-warn"
            >
              {warningLabel(t, warning)}
            </p>
          ))}

          {error ? (
            <p data-testid="skills-error" className="px-1 text-xs text-danger">
              {translateError(t, { code: errorCode ?? 'internal', message: error })}
            </p>
          ) : null}
        </div>
      </Column>

      <Column border="none" className="bg-bg-panel">
        <PageHeader
          title={detail?.meta.name ?? t('settings.skills.detailIdleTitle')}
          actions={
            selectedName ? (
              <Button
                variant="danger"
                data-testid="skill-delete"
                onClick={() => {
                  if (!deleteArmed) {
                    setDeleteArmed(true)
                    return
                  }
                  void useSkillsStore.getState().remove(selectedName)
                }}
              >
                {deleteArmed ? t('settings.skills.deleteConfirm') : t('common.delete')}
              </Button>
            ) : undefined
          }
        />

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {selectedName === null ? (
            <EmptyState
              icon={Sparkles}
              title={t('settings.skills.selectTitle')}
              description={t('settings.skills.selectDescription')}
            />
          ) : detail === null ? (
            <div className="flex items-center gap-2 text-xs text-fg-faint">
              <Spinner />
              {t('common.loading')}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-2">
                <SectionTitle level={3}>{t('settings.skills.description')}</SectionTitle>
                <p
                  data-testid="skill-detail-description"
                  className="text-xs leading-relaxed text-fg-muted"
                >
                  {detail.meta.description}
                </p>
                <p className="font-mono text-[11px] text-fg-faint">{detail.meta.path}</p>
              </section>

              <section className="flex flex-col gap-2">
                <SectionTitle level={3}>{t('settings.skills.body')}</SectionTitle>
                <div
                  data-testid="skill-detail-body"
                  className="rounded-lg border border-border-strong bg-bg-elevated px-4 py-3"
                >
                  <Markdown>{detail.body}</Markdown>
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <SectionTitle level={3}>{t('settings.skills.files')}</SectionTitle>
                {detail.files.length === 0 ? (
                  <p className="text-[11px] text-fg-faint">{t('settings.skills.noFiles')}</p>
                ) : (
                  <ul data-testid="skill-detail-files" className="flex flex-wrap gap-1.5">
                    {detail.files.map((file) => (
                      <li key={file}>
                        <Badge data-testid="skill-detail-file">{file}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </Column>
    </>
  )
}
