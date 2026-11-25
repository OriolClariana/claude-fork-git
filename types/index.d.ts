declare module 'claude-code' {
  interface PluginState {
    'fork-git-pane': {
      settings: Shaped<Record<string, boolean | number>>
      drafts: Shaped<Record<string, { subject: string; body: string }>>
    }
  }
}
