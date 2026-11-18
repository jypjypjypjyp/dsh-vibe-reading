#!/usr/bin/env node
// Fails when the client bundle carries a colour literal: every colour the
// reader paints must come from a --dsw-* theme token.
import { readFileSync } from 'node:fs'

const files = ['client.js', 'index.js']
const patterns = [
  [/#[0-9a-fA-F]{3,8}\b/g, 'hex colour'],
  [/\b(?:rgb|rgba|hsl|hsla)\(/g, 'rgb()/hsl() colour'],
  [/--pr-[a-z0-9-]+/g, 'private colour variable'],
]
// Named colours only count inside a paint property, so "white-space" is fine.
const paint = /(?:^|;|\{)\s*(?:color|fill|stroke|background(?:-color)?|border(?:-[a-z]+)*-color|border|box-shadow|outline(?:-color)?|caret-color|text-decoration-color)\s*:\s*([^;}]*)/g
const named = /\b(white|black|gray|grey|silver|red|green|blue|orange|yellow|purple|pink|cyan|magenta|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i

let failed = false
for (const file of files) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    // Skip comments; they may mention a colour without painting one.
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    paint.lastIndex = 0
    for (let match = paint.exec(line); match !== null; match = paint.exec(line)) {
      if (named.test(match[1])) {
        failed = true
        console.error(`${file}:${index + 1}: named colour in a paint property — use a --dsw-* token\n  ${trimmed.slice(0, 140)}`)
      }
    }
    for (const [pattern, label] of patterns) {
      pattern.lastIndex = 0
      if (pattern.test(line)) {
        failed = true
        console.error(`${file}:${index + 1}: ${label} — use a --dsw-* token\n  ${trimmed.slice(0, 140)}`)
      }
    }
  })
}

if (failed) {
  console.error('\nTheme check failed: colours must come from theme tokens.')
  process.exit(1)
}
console.log('theme check: no colour literals in client.js or index.js')
