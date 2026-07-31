export const DESCRIPTION = "I use this to read or search one of the crew's private memory files."

export const PROMPT = `Each of the crew (dexter, hank, merlin, otto, scout) keeps its own private memory of what it has learned. I use this to look into one of theirs — e.g. sir asks "what does dexter remember about the Slack style guide" or I need to check if otto already knows something before asking it to redo work.

Pick "agent" for whose memory to check, then either:
- query: search that agent's memory (contents + filenames) and get back the best matches with snippets
- name: read one of their files in full by its exact name, or "list" to see everything they have

This is read-only and separate from my own memory tools, which only ever touch my own store.`
