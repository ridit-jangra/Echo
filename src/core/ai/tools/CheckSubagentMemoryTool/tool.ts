import { tool } from 'ai'
import { z } from 'zod'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { ECHO_BASE_DIR } from '../../utils/env'
import { DESCRIPTION, PROMPT } from './prompt'

const AGENT_MEMORY_DIRS = {
  dexter: 'dexter-memory',
  hank: 'hank-memory',
  merlin: 'merlin-memory',
  otto: 'otto-memory',
  scout: 'scout-memory'
} as const

type AgentName = keyof typeof AGENT_MEMORY_DIRS

type MemoryHit = {
  file: string
  score: number
  snippet: string
}

function listMemoryFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.mdc'))
}

function searchMemory(dir: string, query: string, limit = 5): MemoryHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
  if (terms.length === 0) return []

  const hits: MemoryHit[] = []

  for (const file of listMemoryFiles(dir)) {
    let content: string
    try {
      content = readFileSync(join(dir, file), 'utf-8')
    } catch {
      continue
    }

    const haystack = content.toLowerCase()
    const nameHay = file.toLowerCase()
    const lines = content.split('\n')

    let score = 0
    const matchedTerms = new Set<string>()

    for (const term of terms) {
      if (nameHay.includes(term)) {
        score += 6
        matchedTerms.add(term)
      }
      let idx = haystack.indexOf(term)
      let count = 0
      while (idx !== -1) {
        count++
        idx = haystack.indexOf(term, idx + term.length)
      }
      if (count > 0) {
        score += count
        matchedTerms.add(term)
      }
    }

    if (score === 0) continue

    score += matchedTerms.size * 3

    const snippetLines: string[] = []
    for (const line of lines) {
      const ll = line.toLowerCase()
      if (terms.some((t) => ll.includes(t))) {
        const trimmed = line.trim()
        if (trimmed) snippetLines.push(trimmed)
      }
      if (snippetLines.length >= 4) break
    }

    hits.push({ file, score, snippet: snippetLines.join(' … ').slice(0, 400) })
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

const inputSchema = z.object({
  agent: z
    .enum(['dexter', 'hank', 'merlin', 'otto', 'scout'])
    .describe("Which crew member's memory to check."),
  query: z
    .string()
    .optional()
    .describe(
      "Keywords or a phrase to search across that agent's memory files (contents + filenames)."
    ),
  name: z
    .string()
    .optional()
    .describe('Exact memory file name to read in full, or "list" to see all their files.')
})

export const CheckSubagentMemoryTool = tool({
  title: 'Check Subagent Memory',
  description: DESCRIPTION + '\n\n' + PROMPT,
  inputSchema,
  execute: async ({ agent, query, name }) => {
    const dir = join(ECHO_BASE_DIR, AGENT_MEMORY_DIRS[agent as AgentName])

    try {
      if (!existsSync(dir)) {
        return { success: true, content: '', message: `${agent} has no memory files yet` }
      }

      if (query && query.trim()) {
        const results = searchMemory(dir, query)
        if (results.length === 0) {
          return {
            success: true,
            results: [],
            files: listMemoryFiles(dir),
            message: `No memory matched "${query}" for ${agent}. Listing all files instead.`
          }
        }
        return { success: true, agent, query, results }
      }

      if (!name || name === 'list') {
        return { success: true, agent, files: listMemoryFiles(dir) }
      }

      const fullPath = join(dir, name)
      if (!fullPath.startsWith(dir)) {
        return { success: false, error: 'Invalid memory file path' }
      }

      if (!existsSync(fullPath)) {
        const fallback = searchMemory(dir, name)
        return {
          success: false,
          message: `Memory file "${name}" not found for ${agent}`,
          suggestions: fallback.map((h) => h.file)
        }
      }

      const content = readFileSync(fullPath, 'utf-8')
      return { success: true, agent, content }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }
})
