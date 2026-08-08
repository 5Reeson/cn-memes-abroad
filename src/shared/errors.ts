export class CollectionError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_MANIFEST' | 'IMPORT_FAILED' | 'INVALID_INPUT',
  ) {
    super(message)
    this.name = 'CollectionError'
  }
}
