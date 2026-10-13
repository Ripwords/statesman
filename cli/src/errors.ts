/** An expected failure: printed without a stack, exits with its code. */
export class CliError extends Error {
  override name = 'CliError'
  constructor(
    message: string,
    readonly exitCode: 1 | 2
  ) {
    super(message)
  }
}
