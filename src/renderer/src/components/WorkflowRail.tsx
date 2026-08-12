import { CheckIcon as Check } from '@phosphor-icons/react/Check'
import type { ExportTask } from '../../../shared/domain.js'

const steps = [
  { id: 1 as const, title: '选择表情', empty: '从微信、本机或表情库开始' },
  { id: 2 as const, title: '选择目的地', empty: '选择 App 或本地文件夹' },
  { id: 3 as const, title: '挑选表情', empty: '筛选、选择并调整顺序' },
  { id: 4 as const, title: '传输表情', empty: '检查分组并开始传输' },
]

export function WorkflowRail({
  task,
  onStep,
}: {
  task: ExportTask
  onStep(step: ExportTask['currentStep']): void
}) {
  const summaries: Partial<Record<ExportTask['currentStep'], string>> = {
    1: task.source?.label,
    2:
      task.destination?.kind === 'whatsapp'
        ? 'WhatsApp'
        : task.destination?.kind === 'local-folder'
          ? (task.destination.directoryLabel ?? '本地文件夹')
          : undefined,
    3: task.selectedAssetIds.length ? `${task.selectedAssetIds.length} 张已选择` : undefined,
    4: task.prepared
      ? task.prepared.status === 'complete'
        ? '传输完成'
        : task.prepared.snapshotId
          ? '已准备并保留副本'
          : '已有准备结果'
      : undefined,
  }
  return (
    <aside className="workflow-rail" aria-label="导出表情包步骤">
      <h1>导出表情包</h1>
      <ol>
        {steps.map((step) => {
          const current = task.currentStep === step.id
          const completed = step.id < task.currentStep
          const available = step.id <= task.currentStep || Boolean(summaries[step.id])
          return (
            <li
              className={`${current ? 'is-current' : ''}${completed ? ' is-complete' : ''}`}
              key={step.id}
            >
              <button type="button" disabled={!available} onClick={() => onStep(step.id)}>
                <span className="workflow-step-number">
                  {completed ? <Check size={14} weight="bold" /> : step.id}
                </span>
                <span>
                  <strong>{step.title}</strong>
                  <small>{summaries[step.id] ?? step.empty}</small>
                </span>
                {completed && <em>修改</em>}
              </button>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
