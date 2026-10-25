export const slashCommands = [
  ['help', 'Show available commands'], ['connect', 'Connect a model provider'], ['providers', 'Manage model providers'],
  ['model', 'Choose a model'], ['resume', 'Resume a conversation'], ['session', 'Show this conversation'],
  ['name', 'Rename this conversation'], ['tasks', 'Browse conversations'], ['new', 'Start a new conversation'], ['clear', 'Start fresh; keep previous conversations'],
  ['trust', 'Manage project trust'], ['paste', 'Attach an image from the clipboard'], ['attach', 'Attach an image file'],
  ['images', 'Preview or remove attached images'], ['processes', 'Manage background processes'], ['skills', 'Manage Agent Skills'],
  ['desktop', 'Open this conversation in Shun'], ['stop', 'Stop the current task'], ['quit', 'Exit the terminal'],
].map(([name, description]) => ({ name, description }))
