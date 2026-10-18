export function workbenchListState(status: number, connected: boolean | undefined, errorCode?: string) {
  if (status === 200) return connected === false ? 'no_channels' : 'empty';
  if (errorCode === 'conversation_backend_access_denied' || errorCode === 'chatwoot_account_not_configured') return 'setup_error';
  if (status === 403) return 'forbidden';
  if (status === 400) return 'invalid_search';
  return 'unavailable';
}
