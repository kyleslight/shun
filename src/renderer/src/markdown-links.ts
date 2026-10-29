// Keep relative paths and local file URLs for the conversation's local-file
// click handler. Escape the hyphen: .-: would otherwise swallow / and digits.
export const markdownAllowedUri = /^(?:(?:https?|mailto|tel):|file:\/\/\/|shun:\/\/task\/[a-zA-Z0-9-]+$|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
