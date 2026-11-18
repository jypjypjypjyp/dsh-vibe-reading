#!/usr/bin/env node
// Fails when a pr-* class is used in the client bundle but never styled: such a
// node silently keeps the browser's default chrome instead of the theme's.
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const used = new Set()
for (const match of source.matchAll(/className:\s*"([^"]+)"/g)) {
  for (const token of match[1].split(/\s+/)) {
    if (token.startsWith('pr-')) used.add(token)
  }
}

const defined = new Set()
for (const match of source.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)(?=[:{\s,]|$)/g)) {
  if (match[1].startsWith('pr-')) defined.add(match[1])
}

const missing = [...used].filter((name) => !defined.has(name)).sort()
if (missing.length > 0) {
  console.error(`unstyled classes: ${missing.join(', ')}`)
  console.error('Style them in the CSS array, or drop the class name.')
  process.exit(1)
}
console.log(`css check: ${used.size} pr-* classes used, all styled`)
