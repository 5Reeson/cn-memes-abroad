import { useEffect, type PropsWithChildren } from 'react'

interface DialogProps {
  className: string
  backdropClassName?: string
  surfaceAs?: 'div' | 'section'
  ariaLabel?: string
  ariaLabelledBy?: string
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  onClose(): void
}

export function Dialog({
  className,
  backdropClassName,
  surfaceAs: Surface = 'div',
  ariaLabel,
  ariaLabelledBy,
  closeOnBackdrop = true,
  closeOnEscape = true,
  onClose,
  children,
}: PropsWithChildren<DialogProps>) {
  useEffect(() => {
    if (!closeOnEscape) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeOnEscape, onClose])

  return (
    <div
      className={`preview-backdrop${backdropClassName ? ` ${backdropClassName}` : ''}`}
      role="presentation"
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <Surface
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </Surface>
    </div>
  )
}
