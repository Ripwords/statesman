/**
 * A generated password to show once. `created` is a brand-new account;
 * `reset` replaced the password of one that may have been signed in, so it
 * also ended their sessions.
 */
export type PasswordReveal = { email: string; password: string; kind: 'created' | 'reset' }
