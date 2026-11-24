import { useState } from 'react'
import {
  DisclosureRow, StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { XlBuildRunCardData, XlBuildRunCardStatus } from './definition.ts'
import type { XlBuildKey } from '../locales.ts'
import css from './run-card.module.css'

/** Complete keyed Chat renderer props for one durable xl-build run. */
export type XlBuildRunCardProps =
  PropsRuntime<'conversation.chat.node', 'xl-build-run'>
  & PropsLocale<'xl-build'>

const STATUS_KEYS = {
  running: 'cardStatus.running',
  completed: 'cardStatus.completed',
  failed: 'cardStatus.failed',
  skipped: 'cardStatus.skipped',
  cancelled: 'cardStatus.cancelled',
  interrupted: 'cardStatus.interrupted',
} as const satisfies Record<XlBuildRunCardStatus, XlBuildKey>

function dotState(status: XlBuildRunCardStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'skipped':
    case 'cancelled':
    case 'interrupted': return 'warning'
  }
}

function memoryText(
  data: XlBuildRunCardData,
  t: XlBuildRunCardProps['t'],
): string | undefined {
  const memory = data.memory
  if (memory === undefined) return undefined
  if (memory.outcome === 'updated') {
    return memory.updatedBytes === undefined
      ? undefined
      : t('memoryUpdated', { bytes: memory.updatedBytes })
  }
  if (memory.outcome === 'kept') {
    return memory.reason === undefined ? undefined : t('memoryKept', { reason: memory.reason })
  }
  return memory.injectedBytes === undefined
    ? undefined
    : t('memoryInjected', { bytes: memory.injectedBytes })
}

function memberMeta(member: XlBuildRunCardData['members'][number], t: XlBuildRunCardProps['t']): string {
  const kind = member.kind === '' ? '-' : member.kind
  return member.attempt > 1 ? kind + ' \u00b7 ' + t('cardAttempt', { attempt: member.attempt }) : kind
}

/**
 * Render the durable xl-build run card inside the session timeline: one
 * disclosure header with live status and every node that actually started,
 * plus the workflow memory line.
 */
export function XlBuildRunCard({ node, t }: XlBuildRunCardProps) {
  const data = node.data
  const [open, setOpen] = useState(data.status !== 'completed')
  const memory = memoryText(data, t)
  return (
    <div className={css.root}>
      <DisclosureRow
        icon={null}
        title={t('runCardTitle', { name: data.name === '' ? '-' : data.name })}
        open={open}
        expandable
        onToggle={() => setOpen((value) => !value)}
        expandOnRowClick
        keepContentWhenOpen
        rowClassName={css.runHeader}
        contentClassName={css.runSummary}
        collapsedContent={(
          <span className={css.statusTail}>
            <span className={css.separator} />
            {t('cardMemberCount', { count: data.members.length })}
            <StateDot state={dotState(data.status)} />
            {t(STATUS_KEYS[data.status])}
          </span>
        )}
      >
        <div className={css.members}>
          {data.members.map((member) => (
            <div key={member.label} className={css.memberRow}>
              <span className={css.memberDot}>
                <StateDot state={dotState(member.status)} />
              </span>
              <span className={css.memberLabel}>{member.label}</span>
              <span className={css.memberMeta}>{memberMeta(member, t)}</span>
              <span className={css.memberStatus}>{t(STATUS_KEYS[member.status])}</span>
            </div>
          ))}
          {memory !== undefined ? <div className={css.memoryLine}>{memory}</div> : null}
        </div>
      </DisclosureRow>
    </div>
  )
}
