// Lets modules that can't safely import ai/index.ts directly (it would create an
// import cycle — e.g. scheduler.ts is imported by ScheduleTool, which ai/index.ts
// imports) still record a proactive spoken line into Miles's session history, the
// same way noteProactiveLine() does. ai/index.ts registers the real implementation
// at startup; everything else just calls noteProactiveSpoken().
let noteFn: ((line: string) => void) | null = null

export function setProactiveNoteHandler(fn: (line: string) => void): void {
  noteFn = fn
}

export function noteProactiveSpoken(line: string): void {
  noteFn?.(line)
}
