import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/WarningCircle'
import { XIcon as X } from '@phosphor-icons/react/X'

export function ProductBanner({
  tone,
  message,
  onDismiss,
}: {
  tone: 'error' | 'notice'
  message: string
  onDismiss(): void
}) {
  const isError = tone === 'error'
  const Icon = isError ? WarningCircle : CheckCircle

  return (
    <div className={`product-banner ${tone}`} role={isError ? 'alert' : 'status'}>
      <Icon size={18} />
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label={isError ? '关闭错误' : '关闭提示'}>
        <X size={16} />
      </button>
    </div>
  )
}
