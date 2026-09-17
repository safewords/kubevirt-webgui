import { load } from 'js-yaml'

/**
 * Parse YAML, answering `null` for a document with nothing in it — blank, or
 * only comments such as a bare `#cloud-config`. js-yaml 5 throws "expected a
 * document" on those, where an empty document is a perfectly good answer.
 */
export function loadYaml(text: string): unknown {
  const meaningful = text.split('\n').some((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#') && trimmed !== '---' && trimmed !== '...'
  })
  return meaningful ? load(text) : null
}
