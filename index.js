/**
 * dsh-vibe-reading — host half.
 *
 * Serves everything the sidebar reader needs from one prefix route:
 *   /vibe-reading/api/library   GET    paper index
 *   /vibe-reading/api/upload    POST   raw PDF bytes -> stored paper
 *   /vibe-reading/api/import    POST   {"url": "..."} -> download -> stored paper
 *   /vibe-reading/api/doc       GET/PATCH/DELETE  one paper's metadata + annotations
 *   /vibe-reading/file          GET    original PDF bytes (Range capable)
 *   /vibe-reading/thumb         GET|POST page-one preview, stored beside the pdf
 *   /vibe-reading/static/*      GET    vendored pdf.js runtime, cmaps, standard fonts
 *
 * Papers live outside any single workspace (`~/.dsh/vibe-reading/`) so the
 * library survives session switches: `<id>.pdf` is the untouched upload and
 * `<id>.json` carries the title, reading position and annotations.
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { appendFile, cp, link, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

/** Plugin identity for the Loader row / client-modules keying. */
export const name = 'dsh-vibe-reading'

/** Route registration + the web startup's trusted-host fence. */
export const inject = ['webServer', 'webStartup']

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')
const STORE_DIR = process.env.DSH_VIBE_READING_DIR !== undefined && process.env.DSH_VIBE_READING_DIR !== ''
  ? resolve(process.env.DSH_VIBE_READING_DIR)
  : join(homedir(), '.dsh', 'vibe-reading')

/** One upload may carry at most this many bytes. */
const MAX_UPLOAD = 160 * 1024 * 1024
/** How long a link import may take before it is abandoned. */
const MAX_IMPORT_MS = 120000
/** Metadata/annotation writes are small; anything larger is a mistake. */
const MAX_META_BODY = 8 * 1024 * 1024
/** Upper bound on stored annotations per paper. */
const MAX_ANNOTATIONS = 2000
/** Paper-level notes: short conclusions that outlive one session. */
const MAX_PAPER_NOTES = 500
const MAX_NOTE_CHARS = 2000

/** Settings file next to the papers; it never leaves this machine. */
const SETTINGS_PATH = join(STORE_DIR, 'settings.json')
const DEFAULT_SETTINGS = {
  /** 'global' keeps every paper in STORE_DIR; 'workspace' puts new ones in <workspace>/.vibe_reading. */
  storage: 'global',
  /** Workspace directories that already own a .vibe_reading folder. */
  workspaceRoots: [],
  workRoot: join(homedir(), '.paper_reading'),
  mineruApiKey: '',
  mineruModel: 'vlm',
  mineruLang: 'ch',
}

/** Running MinerU jobs, keyed by paper id; status also lands in the paper meta. */
const parseJobs = new Map()

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
}

// ── browser-trust fence (same semantics as the /sidebar gateway) ─────────────

function header(headers, key) {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── small HTTP helpers ───────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message, code = 'error') {
  if (res.headersSent) {
    res.destroy()
    return
  }
  sendJson(res, status, { ok: false, error: { code, message } })
}

function readBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (status, message) => {
      if (settled) return
      settled = true
      const error = new Error(message)
      error.status = status
      rejectBody(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(413, `request body exceeds ${limit} bytes`)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolveBody(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      rejectBody(error)
    })
  })
}

function parseRange(raw, size) {
  if (raw === undefined) return null
  const match = /^bytes=(.+)$/i.exec(raw.trim())
  if (!match) return null
  const spec = match[1].split(',')[0].trim()
  if (spec === '') return null
  if (spec.startsWith('-')) {
    const suffix = Number(spec.slice(1))
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    if (suffix >= size) return { start: 0, end: size - 1 }
    return { start: size - suffix, end: size - 1 }
  }
  const dash = spec.indexOf('-')
  if (dash === -1) return null
  const startText = spec.slice(0, dash)
  const endText = spec.slice(dash + 1)
  const start = startText === '' ? 0 : Number(startText)
  const end = endText === '' ? size - 1 : Number(endText)
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end)) return null
  if (start >= size) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

function serveFile(req, res, path, size, type, extraHeaders = {}) {
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    ...extraHeaders,
  }
  const range = parseRange(header(req.headers, 'range'), size)
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }
  if (range !== null) {
    const { start, end } = range
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(path, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(path)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

// ── storage ──────────────────────────────────────────────────────────────────

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function docId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : ''
  return ID_RE.test(id) ? id : undefined
}

function expandHome(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** id -> directory holding that paper's pdf/json; filled by refreshIndex(). */
const paperDirs = new Map()
let indexStamp = 0

function storeOf(id) {
  return paperDirs.get(id) ?? STORE_DIR
}

function pdfPath(id) {
  return join(storeOf(id), `${id}.pdf`)
}

function metaPath(id) {
  return join(storeOf(id), `${id}.json`)
}

/** Page-one preview; written once by the client and reused on every later open. */
function thumbPath(id) {
  return join(storeOf(id), `${id}.thumb.jpg`)
}

/** A workspace's own store keeps its pdf/json one level in, so the folder stays readable. */
function storeDirFor(workspacePath) {
  return join(workspacePath, '.vibe_reading', 'store')
}

/** Entries may name a workspace or its .vibe_reading directory; both mean the workspace. */
function workspaceOf(root) {
  return root.endsWith(`${sep}.vibe_reading`) ? dirname(root) : root
}

/** Every directory that may hold papers: the global store plus known workspaces. */
async function storeRoots() {
  const settings = await readSettings()
  const roots = [STORE_DIR]
  const legacy = []
  for (const root of settings.workspaceRoots) {
    const workspace = workspaceOf(root)
    roots.push(storeDirFor(workspace))
    // Papers moved by earlier versions sit directly in .vibe_reading; read them too.
    legacy.push(join(workspace, '.vibe_reading'))
  }
  return { roots: Array.from(new Set(roots)), legacy: Array.from(new Set(legacy)) }
}

async function refreshIndex(force) {
  const now = Date.now()
  if (force !== true && now - indexStamp < 1200) return
  indexStamp = now
  const { roots, legacy } = await storeRoots()
  const seen = new Set()
  for (const root of [...roots, ...legacy]) {
    const names = await readdir(root).catch(() => [])
    for (const entry of names) {
      if (!entry.endsWith('.json')) continue
      const id = entry.slice(0, -'.json'.length)
      if (!ID_RE.test(id) || seen.has(id)) continue
      seen.add(id)
      paperDirs.set(id, root)
    }
  }
}

async function ensureStore() {
  await mkdir(STORE_DIR, { recursive: true })
}

async function readMeta(id) {
  if (!paperDirs.has(id)) await refreshIndex(true)
  const text = await readFile(metaPath(id), 'utf8')
  const meta = JSON.parse(text)
  return normalizeMeta(meta, id)
}

function normalizeMeta(meta, id) {
  return {
    id,
    title: typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title.trim() : 'Untitled paper',
    fileName: typeof meta.fileName === 'string' ? meta.fileName : '',
    size: Number.isFinite(meta.size) ? meta.size : 0,
    createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : Date.now(),
    updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : Date.now(),
    pageCount: Number.isInteger(meta.pageCount) && meta.pageCount > 0 ? meta.pageCount : null,
    lastPage: Number.isInteger(meta.lastPage) && meta.lastPage > 0 ? meta.lastPage : 1,
    scrollRatio: Number.isFinite(meta.scrollRatio) ? Math.min(Math.max(meta.scrollRatio, 0), 1) : 0,
    annotations: Array.isArray(meta.annotations) ? meta.annotations.map(normalizeAnnotation).filter(Boolean) : [],
    paperNotes: Array.isArray(meta.paperNotes) ? meta.paperNotes.map(normalizePaperNote).filter(Boolean).slice(0, MAX_PAPER_NOTES) : [],
    code: normalizeCode(meta.code),
    keywords: Array.isArray(meta.keywords)
      ? meta.keywords.filter((word) => typeof word === 'string' && word.trim() !== '').map((word) => word.trim().slice(0, 24)).slice(0, 8)
      : [],
    workDir: typeof meta.workDir === 'string' ? meta.workDir.slice(0, 4000) : '',
    store: typeof meta.store === 'string' ? meta.store.slice(0, 4000) : '',
    workspace: normalizeWorkspace(meta.workspace),
    parse: normalizeParse(meta.parse),
  }
}

function normalizeWorkspace(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const path = typeof value.path === 'string' ? value.path.slice(0, 4000) : ''
  return { path, name: typeof value.name === 'string' ? value.name.slice(0, 120) : '' }
}

function normalizeCode(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const clone = value.clone !== null && typeof value.clone === 'object' ? value.clone : {}
  const status = ['idle', 'running', 'done', 'error'].includes(clone.status) ? clone.status : 'idle'
  return {
    repo: typeof value.repo === 'string' ? value.repo.slice(0, 2000) : '',
    note: typeof value.note === 'string' ? value.note.slice(0, 20000) : '',
    clone: {
      status,
      message: typeof clone.message === 'string' ? clone.message.slice(0, 500) : '',
      startedAt: Number.isFinite(clone.startedAt) ? clone.startedAt : 0,
      finishedAt: Number.isFinite(clone.finishedAt) ? clone.finishedAt : 0,
    },
  }
}

/** Independent counts for the two code trees under the paper folder. */
function codeCount(dir) {
  return readdir(dir).then((entries) => entries.length).catch(() => 0)
}

/**
 * The paper folder's meta file: everything a fresh session needs to know before
 * it opens a single page, without asking the reader UI.
 */
function renderPaperMeta(meta, info) {
  const keywords = Array.isArray(meta.keywords) ? meta.keywords : []
  const parse = meta.parse === undefined ? { status: 'idle' } : meta.parse
  const repo = meta.code.repo === '' ? '未关联' : meta.code.repo
  const clone = meta.code.clone === undefined ? { status: 'idle' } : meta.code.clone
  const cloneLine = clone.status === 'running'
    ? '克隆中'
    : clone.status === 'error'
      ? `克隆失败：${clone.message}`
      : clone.status === 'done'
        ? '已克隆'
        : '未克隆'
  const parsedLabel = parse.status === 'done'
    ? (info.markdown === '' ? '完成' : String(info.markdown).replace(info.dir + '/', ''))
    : parse.status === 'running' ? '进行中' : '未解析'
  return [
    `# ${meta.title}`,
    '',
    `- paper id: ${meta.id}`,
    `- 页数: ${meta.pageCount === null ? '未知' : meta.pageCount}`,
    `- 领域关键词: ${keywords.length === 0 ? '（未标注）' : keywords.join('、')}`,
    `- 开源仓库: ${repo}（${cloneLine}；remote/ ${info.remoteFiles} 项）`,
    `- 本地复现: local/ ${info.localFiles} 项`,
    `- 解析: ${parsedLabel}`,
    `- 原文: pdf/${info.fileName}`,
    '',
    '## 目录',
    '',
    '- `pdf/` 原始 PDF',
    '- `markdown/` 解析正文，可能带 `images/`',
    '- `remote/` 开源实现（克隆来的）',
    '- `local/` 本地复现代码',
    '- `notes.md` 标注与笔记（唯一可读文档）',
    '- `meta.md` 本文件',
    '',
  ].join('\n')
}

function normalizeParse(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const status = ['idle', 'running', 'done', 'error'].includes(value.status) ? value.status : 'idle'
  const engine = value.engine === 'mineru' ? 'mineru' : 'markdown'
  const progress = Number.isFinite(value.progress) ? Math.min(Math.max(value.progress, 0), 1) : status === 'done' ? 1 : 0
  return {
    status,
    engine,
    progress,
    dir: typeof value.dir === 'string' ? value.dir.slice(0, 2000) : '',
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : 0,
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : 0,
    error: typeof value.error === 'string' ? value.error.slice(0, 2000) : '',
  }
}

function normalizePaperNote(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_NOTE_CHARS) : ''
  if (text === '') return undefined
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 80) : randomUUID(),
    title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 48) : '',
    text,
    author: raw.author === 'ai' ? 'ai' : 'human',
    sourceSessionId: '',
    sourceSessionTitle: '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

function clamp01(value) {
  return Math.min(Math.max(Number(value), 0), 1)
}

function normalizeAnnotation(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const rects = Array.isArray(raw.rects)
    ? raw.rects
        .filter((rect) => Array.isArray(rect) && rect.length === 4 && rect.every((n) => Number.isFinite(n)))
        .slice(0, 400)
        .map((rect) => [clamp01(rect[0]), clamp01(rect[1]), clamp01(rect[2]), clamp01(rect[3])])
    : []
  const page = Number.isInteger(raw.page) && raw.page > 0 ? raw.page : 1
  const kind = raw.kind === 'note' ? 'note' : 'highlight'
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 20000) : ''
  // A model-authored annotation anchors at page level: it has no viewport
  // geometry to draw from, so an empty rect list is valid as long as it says
  // something.
  if (rects.length === 0 && text === '' && typeof raw.note !== 'string') return undefined
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 80) : randomUUID(),
    kind,
    page,
    rects,
    text,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 20000) : '',
    color: typeof raw.color === 'string' ? raw.color.slice(0, 24) : '',
    author: raw.author === 'ai' ? 'ai' : 'human',
    sourceSessionId: typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId.slice(0, 80) : '',
    sourceSessionTitle: typeof raw.sourceSessionTitle === 'string' ? raw.sourceSessionTitle.slice(0, 200) : '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

function summaryOf(meta) {
  return {
    id: meta.id,
    title: meta.title,
    fileName: meta.fileName,
    size: meta.size,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pageCount: meta.pageCount,
    lastPage: meta.lastPage,
    highlightCount: meta.annotations.filter((a) => a.kind === 'highlight').length,
    noteCount: meta.annotations.filter((a) => a.kind === 'note').length,
    aiCount: meta.annotations.filter((a) => a.author === 'ai').length,
    paperNoteCount: meta.paperNotes.length,
    parseStatus: meta.parse.status,
    codeRepo: meta.code.repo,
    keywords: meta.keywords,
    workspacePath: meta.workspace.path,
    workspaceName: meta.workspace.name,
    storage: meta.store !== '' && meta.store !== STORE_DIR ? 'workspace' : 'global',
  }
}

async function writeMeta(meta) {
  await ensureStore()
  const target = metaPath(meta.id)
  const temp = `${target}.tmp-${process.pid}`
  await writeFile(temp, JSON.stringify(meta, null, 2))
  await rename(temp, target)
}

/** Workspaces that either hold papers or are registered as a store location. */
async function listWorkspaces() {
  const settings = await readSettings()
  const docs = await listLibrary()
  const found = new Map()
  for (const root of settings.workspaceRoots) {
    const workspace = workspaceOf(root)
    found.set(workspace, { path: workspace, name: basename(workspace), count: 0 })
  }
  for (const doc of docs) {
    if (doc.workspacePath === '') continue
    const entry = found.get(doc.workspacePath) ?? { path: doc.workspacePath, name: doc.workspaceName, count: 0 }
    entry.count += 1
    found.set(doc.workspacePath, entry)
  }
  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name))
}

async function listLibrary() {
  await ensureStore()
  await refreshIndex(true)
  const docs = []
  for (const [id, root] of paperDirs) {
    try {
      const text = await readFile(join(root, `${id}.json`), 'utf8')
      docs.push(summaryOf(normalizeMeta(JSON.parse(text), id)))
    } catch {
      // A half-written or foreign JSON file is skipped, never fatal.
    }
  }
  docs.sort((a, b) => b.updatedAt - a.updatedAt)
  return docs
}

// ── settings ─────────────────────────────────────────────────────────────────

async function readSettings() {
  try {
    const text = await readFile(SETTINGS_PATH, 'utf8')
    const stored = JSON.parse(text)
    const merged = { ...DEFAULT_SETTINGS }
    if (stored.storage === 'workspace' || stored.storage === 'global') merged.storage = stored.storage
    if (Array.isArray(stored.workspaceRoots)) {
      merged.workspaceRoots = stored.workspaceRoots
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .map((value) => expandHome(value.trim()))
        .slice(0, 40)
    }
    if (typeof stored.workRoot === 'string' && stored.workRoot.trim() !== '') merged.workRoot = expandHome(stored.workRoot.trim())
    if (typeof stored.mineruApiKey === 'string') merged.mineruApiKey = stored.mineruApiKey.trim()
    if (['vlm', 'pipeline', 'MinerU-HTML'].includes(stored.mineruModel)) merged.mineruModel = stored.mineruModel
    if (typeof stored.mineruLang === 'string' && stored.mineruLang.trim() !== '') merged.mineruLang = stored.mineruLang.trim()
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function writeSettings(patch) {
  const current = await readSettings()
  if (patch.storage === 'workspace' || patch.storage === 'global') current.storage = patch.storage
  if (Array.isArray(patch.workspaceRoots)) {
    const listed = patch.workspaceRoots
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => workspaceOf(expandHome(value.trim())))
    // Workspace paths only: the .vibe_reading layout is derived, never stored.
    current.workspaceRoots = Array.from(new Set(listed)).slice(0, 40)
  }
  if (typeof patch.workRoot === 'string' && patch.workRoot.trim() !== '') current.workRoot = expandHome(patch.workRoot.trim())
  if (typeof patch.mineruApiKey === 'string') current.mineruApiKey = patch.mineruApiKey.trim()
  if (['vlm', 'pipeline', 'MinerU-HTML'].includes(patch.mineruModel)) current.mineruModel = patch.mineruModel
  if (typeof patch.mineruLang === 'string' && patch.mineruLang.trim() !== '') current.mineruLang = patch.mineruLang.trim()
  await ensureStore()
  const temp = `${SETTINGS_PATH}.tmp-${process.pid}`
  await writeFile(temp, JSON.stringify(current, null, 2))
  await rename(temp, SETTINGS_PATH)
  return current
}

/** Settings as shown in the UI: the API key is redacted to its last four characters. */
function publicSettings(settings) {
  const key = settings.mineruApiKey
  return {
    storage: settings.storage,
    workspaceRoots: settings.workspaceRoots,
    workRoot: settings.workRoot,
    mineruModel: settings.mineruModel,
    mineruLang: settings.mineruLang,
    mineruApiKeySet: key !== '',
    mineruApiKeyHint: key === '' ? '' : `••••${key.slice(-4)}`,
  }
}

// ── paper folders: <workRoot>/<paper>/{pdf,markdown,code} ────────────────────

function slugOf(meta) {
  const base = meta.title !== '' ? meta.title : meta.fileName !== '' ? meta.fileName : meta.id
  const cleaned = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return cleaned === '' ? meta.id : cleaned
}

/**
 * Materialize the paper's folder and return its parts. The folder is created
 * once and then reused, so renaming a paper never moves its files.
 */
/**
 * Clone in the background: a GitHub checkout takes long enough that the request
 * must answer first and the UI poll for the status.
 */
async function startClone(id) {
  const meta = await readMeta(id)
  if (meta.code.repo === '' || !/^https?:\/\//i.test(meta.code.repo)) {
    throw Object.assign(new Error('先在开源仓库一栏填一个 http(s) 地址'), { status: 400 })
  }
  if (meta.code.clone.status === 'running') return meta.code.clone
  const folder = await paperFolder(id)
  const existing = await readdir(folder.remoteDir).catch(() => [])
  if (existing.length > 0) {
    throw Object.assign(new Error('remote/ 已经有内容了'), { status: 409 })
  }
  const startedAt = Date.now()
  meta.code = normalizeCode({ ...meta.code, clone: { status: 'running', message: '', startedAt, finishedAt: 0 } })
  await writeMeta(meta)
  const repo = meta.code.repo
  void cloneInto(repo, folder.remoteDir)
    .then(async () => {
      const next = await readMeta(id)
      next.code = normalizeCode({ ...next.code, clone: { status: 'done', message: '', startedAt, finishedAt: Date.now() } })
      await writeMeta(next)
      await paperBrief(id).catch(() => {})
    })
    .catch(async (error) => {
      const next = await readMeta(id)
      next.code = normalizeCode({ ...next.code, clone: { status: 'error', message: String(error?.message ?? error).slice(0, 400), startedAt, finishedAt: Date.now() } })
      await writeMeta(next)
      await paperBrief(id).catch(() => {})
    })
  return meta.code.clone
}

/** Shallow clone into the paper's code folder. */
function cloneInto(repo, target) {
  return new Promise((resolveClone, rejectClone) => {
    // Only http(s): a leading dash would otherwise be read as a git option.
    if (typeof repo !== 'string' || !/^https?:\/\//i.test(repo.trim())) {
      rejectClone(new Error('repo must be an http(s) URL'))
      return
    }
    const child = spawn('git', ['clone', '--depth', '1', '--', repo.trim(), target], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectClone(Object.assign(new Error('git clone 超时（120 秒）'), { status: 504 }))
    }, 120000)
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectClone(Object.assign(new Error(`git clone 失败：${error.message}`), { status: 500 }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveClone()
      else rejectClone(Object.assign(new Error(`git clone 失败：${stderr.trim().split('\n').slice(-1)[0] || 'exit ' + code}`), { status: 500 }))
    })
  })
}

/** Move one paper (store files + folder) to the store its workspace implies. */
async function relocatePaper(meta, id) {
  const settings = await readSettings()
  const from = storeOf(id)
  const to = targetDirFor(meta, settings.storage, meta.workspace.path)
  if (to !== from) {
    await mkdir(to, { recursive: true })
    await movePath(join(from, `${id}.pdf`), join(to, `${id}.pdf`))
    await movePath(join(from, `${id}.json`), join(to, `${id}.json`))
    await movePath(join(from, `${id}.thumb.jpg`), join(to, `${id}.thumb.jpg`)).catch(() => {})
    paperDirs.set(id, to)
    meta.store = to
  }
  const root = meta.workspace.path !== ''
    ? join(meta.workspace.path, '.vibe_reading', 'papers')
    : settings.workRoot
  const dir = join(root, slugOf(meta))
  if (meta.workDir !== '' && meta.workDir !== dir && existsSync(meta.workDir) && !existsSync(dir)) {
    await mkdir(root, { recursive: true })
    await movePath(meta.workDir, dir).catch(() => {})
  }
  meta.workDir = existsSync(dir) ? dir : ''
  meta.updatedAt = Date.now()
  await writeMeta(meta)
  indexStamp = 0
  return to
}

/** Put the paper's bytes at `dst` without paying for them twice when we can. */
async function linkOrCopy(src, dst) {
  try {
    await link(src, dst)
  } catch {
    await cp(src, dst, { force: true })
  }
}

async function sha1(file) {
  const hash = createHash('sha1')
  await new Promise((settle, fail) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => settle(undefined))
      .on('error', fail)
  })
  return hash.digest('hex')
}

/** Replace paper-folder pdf copies with hard links to the stored copy. */
async function compactPaperCopies() {
  await refreshIndex(true)
  const linked = []
  let bytes = 0
  for (const id of paperDirs.keys()) {
    const meta = await readMeta(id).catch(() => undefined)
    if (meta === undefined || meta.workDir === '') continue
    let dirs = []
    try {
      dirs = (await readdir(join(meta.workDir, 'pdf'))).filter((name) => name.toLowerCase().endsWith('.pdf'))
    } catch {
      continue
    }
    const src = pdfPath(id)
    for (const name of dirs) {
      const dst = join(meta.workDir, 'pdf', name)
      try {
        const [a, b] = [await stat(src), await stat(dst)]
        if (a.ino === b.ino || a.size !== b.size) continue
        if ((await sha1(src)) !== (await sha1(dst))) continue
        await unlink(dst)
        await link(src, dst)
        bytes += a.size
        linked.push({ id, name })
      } catch {
        /* keep the copy when anything is off */
      }
    }
  }
  return { linked, bytes }
}

async function paperFolder(id) {
  const meta = await readMeta(id)
  const settings = await readSettings()
  const root = meta.workspace.path !== ''
    ? join(meta.workspace.path, '.vibe_reading', 'papers')
    : settings.workRoot
  const slug = slugOf(meta)
  const dir = join(root, slug)
  // A folder recorded elsewhere — or left in the global work root — follows the paper.
  for (const candidate of [meta.workDir, join(settings.workRoot, slug)]) {
    if (candidate === '' || candidate === dir || !existsSync(candidate) || existsSync(dir)) continue
    await mkdir(root, { recursive: true })
    await movePath(candidate, dir).catch(() => {})
    break
  }
  const pdfDir = join(dir, 'pdf')
  const mdDir = join(dir, 'markdown')
  const remoteDir = join(dir, 'remote')
  const localDir = join(dir, 'local')
  await mkdir(pdfDir, { recursive: true })
  await mkdir(mdDir, { recursive: true })
  await mkdir(remoteDir, { recursive: true })
  await mkdir(localDir, { recursive: true })

  const rawName = (meta.fileName !== '' ? meta.fileName : 'paper.pdf').replace(/[\\/:*?"<>|]/g, ' ').trim()
  const fileName = rawName === '' ? 'paper.pdf' : rawName.toLowerCase().endsWith('.pdf') ? rawName : `${rawName}.pdf`
  const pdfTarget = join(pdfDir, fileName)
  const existing = await stat(pdfTarget).catch(() => undefined)
  if (existing === undefined) await linkOrCopy(pdfPath(id), pdfTarget)

  if (meta.workDir !== dir) {
    meta.workDir = dir
    await writeMeta(meta).catch(() => {})
  }
  return { meta, settings, dir, pdfDir, mdDir, remoteDir, localDir, pdfTarget, fileName }
}

/** Refresh the folder's notes.md after annotations or notes change elsewhere. */
async function syncPaperNotes(meta) {
  if (meta.workDir === '') return
  await writeFile(join(meta.workDir, 'notes.md'), renderNotesMarkdown(meta)).catch(() => {})
}

async function paperBrief(id) {
  const folder = await paperFolder(id)
  await writeFile(join(folder.dir, 'notes.md'), renderNotesMarkdown(folder.meta)).catch(() => {})
  const markdown = await findMarkdown(folder.mdDir)
  const remoteFiles = await codeCount(folder.remoteDir)
  const localFiles = await codeCount(folder.localDir)
  await writeFile(join(folder.dir, 'meta.md'), renderPaperMeta(folder.meta, {
    dir: folder.dir,
    markdown,
    fileName: folder.fileName,
    remoteFiles,
    localFiles,
  })).catch(() => {})
  await rm(join(folder.dir, 'README.md'), { force: true }).catch(() => {})
  return {
    path: folder.dir,
    pdf: folder.pdfTarget,
    markdown,
    remote: { path: folder.remoteDir, files: remoteFiles },
    local: { path: folder.localDir, files: localFiles },
    code: { repo: folder.meta.code.repo, clone: folder.meta.code.clone },
    keywords: folder.meta.keywords,
    parse: folder.meta.parse,
  }
}

/**
 * What the paper's markdown folder actually holds: whether a markdown file
 * exists, and whether it came with extracted figures (which only MinerU
 * produces, markitdown writes plain text).
 */
async function markdownState(meta) {
  if (meta.workDir === '') return { exists: false, hasImages: false }
  const found = await findMarkdown(join(meta.workDir, 'markdown'))
  if (found === '') return { exists: false, hasImages: false }
  const images = await readdir(join(dirname(found), 'images')).catch(() => [])
  return { exists: true, hasImages: images.length > 0 }
}

async function findMarkdown(dir) {
  const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const direct = names.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'paper.md')
  if (direct !== undefined) return join(dir, direct.name)
  for (const entry of names) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return join(dir, entry.name)
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const nested = await findMarkdown(join(dir, entry.name))
    if (nested !== '') return nested
  }
  return ''
}

/** The paper's one readable document: big notes first, then page-ordered annotations. */
function noteHeading(note) {
  if (typeof note.title === 'string' && note.title !== '') return note.title
  const enclosed = /^【([^】]{1,24})】/.exec(note.text)
  if (enclosed !== null) return enclosed[1]
  const prefixed = /^([^：:\n]{2,12})[：:]/.exec(note.text)
  if (prefixed !== null) return prefixed[1]
  if (/^已读/.test(note.text)) return '已读'
  return '笔记'
}

/** Drop a label the body repeats: the heading already carries it. */
function bodyOfNote(note) {
  const text = note.text
  const heading = noteHeading(note)
  for (const marker of [`${heading}：`, `${heading}:`, `【${heading}】`]) {
    if (text.startsWith(marker)) return text.slice(marker.length).trim()
  }
  return text
}

function renderNotesMarkdown(meta) {
  const stamp = new Date().toISOString()
  const lines = [`# ${meta.title}`, '', `${meta.annotations.length} 条标注 · ${meta.paperNotes.length} 条笔记 · 更新于 ${stamp}`, '']
  if (meta.paperNotes.length > 0) {
    lines.push('## 笔记', '')
    const notes = meta.paperNotes.slice().sort((a, b) => a.createdAt - b.createdAt)
    for (const note of notes) {
      lines.push(`### ${noteHeading(note)}`, '', bodyOfNote(note), '')
    }
  }
  if (meta.annotations.length > 0) {
    lines.push('## 标注', '')
    const ordered = meta.annotations.slice().sort((a, b) => (a.page === b.page ? a.createdAt - b.createdAt : a.page - b.page))
    for (const annotation of ordered) {
      const author = annotation.author === 'ai' ? 'AI' : 'human'
      lines.push(`### p${annotation.page} · ${annotation.kind} · ${author}`)
      if (annotation.text !== '') lines.push('', `> ${annotation.text.replace(/\n/g, '\n> ')}`)
      if (annotation.note !== '') lines.push('', annotation.note)
      lines.push('')
    }
  }
  return lines.join('\n')
}

// ── parsing: markitdown by default, MinerU on request ────────────────────────

/**
 * Local markitdown conversion costs roughly 0.25s per page plus a fixed
 * interpreter start; the bar is calibrated on that, not on a flat guess.
 */
function localParseEstimate(pageCount) {
  return 1500 + Math.max(pageCount, 1) * 260
}

async function patchParse(id, patch) {
  try {
    const meta = await readMeta(id)
    meta.parse = normalizeParse({ ...meta.parse, ...patch })
    meta.updatedAt = Date.now()
    await writeMeta(meta)
  } catch {
    // A vanished paper does not fail the job record.
  }
}

/** Stop whatever parse runs for this paper; the job record keeps the reason. */
function stopParse(id, reason) {
  const job = parseJobs.get(id)
  if (job === undefined) return
  job.halted = reason
  const child = job.child
  job.child = undefined
  if (job.abort !== undefined) {
    try { job.abort.abort() } catch { /* already settled */ }
    job.abort = undefined
  }
  if (job.timer !== undefined) {
    clearInterval(job.timer)
    job.timer = undefined
  }
  if (child !== undefined) {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
  parseJobs.delete(id)
  patchParse(id, { status: 'idle', engine: job.engine, progress: 0, error: reason === 'replaced' ? '' : reason })
}

/** MinerU cloud API root; the token is the only credential. */
const MINERU_API = process.env.DSH_VIBE_READING_MINERU_API ?? 'https://mineru.net/api/v4'
/** Polling cadence and ceiling for one MinerU batch. */
const MINERU_POLL_MS = 3000
const MINERU_DEADLINE_MS = 15 * 60 * 1000

function startParse(id, engine) {
  stopParse(id, 'replaced')

  const job = {
    status: 'running',
    engine,
    progress: 0,
    dir: '',
    startedAt: Date.now(),
    finishedAt: 0,
    error: '',
    child: undefined,
    timer: undefined,
    abort: undefined,
  }
  parseJobs.set(id, job)

  const finish = (failed, message) => {
    if (job.timer !== undefined) {
      clearInterval(job.timer)
      job.timer = undefined
    }
    job.child = undefined
    job.abort = undefined
    if (parseJobs.get(id) !== job) return
    const next = {
      status: failed ? 'error' : 'done',
      engine,
      progress: failed ? job.progress : 1,
      dir: job.dir,
      startedAt: job.startedAt,
      finishedAt: Date.now(),
      error: failed ? String(message ?? '').slice(-1800) : '',
    }
    parseJobs.delete(id)
    patchParse(id, next)
  }

  const report = (progress) => {
    if (parseJobs.get(id) !== job) return
    if (progress > job.progress) job.progress = Math.min(0.99, progress)
    patchParse(id, { status: 'running', engine, progress: job.progress, dir: job.dir, startedAt: job.startedAt, finishedAt: 0, error: '' })
  }

  paperFolder(id).then((folder) => {
    if (parseJobs.get(id) !== job) return
    job.dir = folder.dir
    report(0.02)

    if (engine === 'mineru') {
      runMineru(job, folder, report).then(() => finish(false, '')).catch((error) => {
        if (parseJobs.get(id) !== job) return
        finish(true, error?.message ?? String(error))
      })
      return
    }

    // markitdown: the named conversion tool, spawned through uvx.
    let child
    try {
      child = spawn('uvx', ['--from', 'markitdown[pdf]', 'markitdown', folder.pdfTarget, '-o', join(folder.mdDir, 'paper.md')], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(true, String(error?.message ?? error))
      return
    }
    job.child = child
    let tail = ''
    const collect = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-4000)
      const match = /(\d{1,3})\s*%/.exec(tail.slice(-400))
      if (match !== null) report(Number(match[1]) / 100)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const estimate = localParseEstimate(folder.meta.pageCount ?? 0)
    job.timer = setInterval(() => {
      if (parseJobs.get(id) !== job) return
      report(Math.min(0.95, (Date.now() - job.startedAt) / estimate))
    }, 400)

    child.on('error', (error) => {
      finish(true, error.code === 'ENOENT' ? 'uvx not found on PATH; install uv to parse with markitdown' : String(error?.message ?? error))
    })
    child.on('close', (code) => {
      if (parseJobs.get(id) !== job) return
      finish(code !== 0, code !== 0 ? (tail.trim() === '' ? `exit code ${code}` : tail.trim()) : '')
    })
  }).catch((error) => {
    finish(true, error?.message ?? String(error))
  })

  return { status: 'running', engine, progress: 0, dir: '', startedAt: job.startedAt, finishedAt: 0, error: '' }
}

/** One JSON request against the MinerU API; throws with the service's own message. */
async function mineruRequest(path, token, init) {
  const response = await fetch(`${MINERU_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    const detail = await response.json().then((body) => body?.msg ?? '').catch(() => '')
    throw new Error(`MinerU ${path} failed: HTTP ${response.status}${detail === '' ? '' : ` — ${detail}`}`)
  }
  const body = await response.json()
  if (!(body.code === 0 || body.success === true)) throw new Error(`MinerU: ${body.msg ?? 'request rejected'}`)
  return body.data ?? body
}

/**
 * The whole MinerU round trip in this process: ask for a presigned upload,
 * PUT the PDF, poll the batch, then unzip the result into markdown/.
 */
async function runMineru(job, folder, report) {
  const token = folder.settings.mineruApiKey
  if (token === '') throw new Error('MinerU API key is not configured')

  const abort = new AbortController()
  job.abort = abort
  const file = await readFile(folder.pdfTarget)
  report(0.06)

  const created = await mineruRequest('/file-urls/batch', token, {
    method: 'POST',
    signal: abort.signal,
    body: JSON.stringify({
      enable_formula: true,
      language: folder.settings.mineruLang,
      layout_model: 'doclayout_yolo',
      enable_table: true,
      files: [{
        name: folder.fileName,
        language: folder.settings.mineruLang,
        enable_table: true,
        enable_formula: true,
        is_ocr: false,
      }],
    }),
  })
  const batchId = created.batch_id
  const uploadUrl = Array.isArray(created.file_urls) && created.file_urls.length > 0
    ? typeof created.file_urls[0] === 'string' ? created.file_urls[0] : created.file_urls[0].url ?? created.file_urls[0].upload_url
    : ''
  if (typeof batchId !== 'string' || uploadUrl === undefined || uploadUrl === '') throw new Error('MinerU did not return an upload slot')
  report(0.12)

  const upload = await fetch(uploadUrl, { method: 'PUT', body: file, signal: abort.signal })
  if (upload.status !== 200 && upload.status !== 201) throw new Error(`MinerU upload failed: HTTP ${upload.status}`)
  report(0.24)

  const entry = await mineruPollBatch(batchId, token, abort.signal, job, report)
  report(0.9)

  const zipUrl = entry.full_zip_url ?? entry.zip_url ?? ''
  if (zipUrl === '') throw new Error('MinerU returned no result archive')
  const zip = await fetch(zipUrl, { signal: abort.signal })
  if (!zip.ok) throw new Error(`MinerU result download failed: HTTP ${zip.status}`)
  const archive = Buffer.from(await zip.arrayBuffer())

  await writeZipInto(archive, folder.mdDir)
  report(1)
}

/** Poll one batch until its single file finishes, fails, or the deadline passes. */
async function mineruPollBatch(batchId, token, signal, job, report) {
  const startedAt = Date.now()
  let polls = 0
  while (Date.now() - startedAt < MINERU_DEADLINE_MS) {
    polls += 1
    if (job.abort === undefined) throw new Error('parse cancelled')
    const data = await mineruRequest(`/extract-results/batch/${batchId}`, token, { signal })
    const results = Array.isArray(data.extract_result) ? data.extract_result : []
    if (results.length > 0) {
      const entry = results[0]
      if (entry.state === 'done') return entry
      if (entry.state === 'failed') throw new Error(`MinerU: ${entry.err_msg ?? 'parse failed'}`)
    }
    // Queued and running both read as steady progress under the 90% mark.
    report(Math.min(0.88, 0.24 + polls * 0.04))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, MINERU_POLL_MS))
  }
  throw new Error('MinerU timed out after 15 minutes')
}

/**
 * Read a ZIP archive with zlib only: the result bundle carries one markdown
 * file plus its images, so a central-directory walk is all this needs.
 */
function unzipEntries(buffer) {
  let eocd = -1
  const floor = Math.max(0, buffer.length - 66000)
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('MinerU result is not a ZIP archive')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const raw = buffer.subarray(dataStart, dataStart + compressedSize)
      entries.push({ name, method, raw })
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Write the archive's markdown and images into the paper's markdown/ folder. */
async function writeZipInto(archive, mdDir) {
  const entries = unzipEntries(archive)
  const decode = (entry) => (entry.method === 0 ? entry.raw : inflateRawSync(entry.raw))

  const markdown = entries
    .filter((entry) => !entry.name.endsWith('/') && entry.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.name.length - b.name.length)[0]
  if (markdown === undefined) throw new Error('MinerU result carries no markdown')

  await mkdir(mdDir, { recursive: true })
  await writeFile(join(mdDir, 'paper.md'), decode(markdown))

  const imageEntries = entries.filter((entry) => !entry.name.endsWith('/') && entry.name.includes('images/'))
  if (imageEntries.length > 0) await mkdir(join(mdDir, 'images'), { recursive: true })
  let images = 0
  for (const entry of imageEntries) {
    const localName = entry.name.slice(entry.name.lastIndexOf('/') + 1)
    if (localName === '') continue
    await writeFile(join(mdDir, 'images', localName), decode(entry))
    images += 1
  }
  return { images }
}

/** The live job if one runs, else the persisted parse record. */
async function parseStateOf(id) {
  const live = parseJobs.get(id)
  if (live !== undefined) {
    return {
      status: 'running',
      engine: live.engine,
      progress: live.progress,
      dir: live.dir,
      startedAt: live.startedAt,
      finishedAt: 0,
      error: '',
    }
  }
  const meta = await readMeta(id)
  return meta.parse
}

/** List one directory for the code panel; names only, no recursion. */
async function listDirectory(rawPath) {
  const requested = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (requested === '') throw Object.assign(new Error('missing path'), { status: 400 })
  const expanded = requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested
  const target = resolve(expanded)
  const info = await stat(target).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${target}`), { status: 400 })
  }
  const names = await readdir(target, { withFileTypes: true })
  const entries = []
  for (const name of names) {
    if (name.name.startsWith('.') && name.name !== '.gitignore') continue
    if (name.name === 'node_modules' || name.name === '.git') continue
    const child = join(target, name.name)
    let size = 0
    if (name.isFile()) {
      const childInfo = await stat(child).catch(() => undefined)
      size = childInfo?.size ?? 0
    }
    entries.push({ name: name.name, dir: name.isDirectory(), size })
    if (entries.length >= 400) break
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return { path: target, entries }
}

// ── route handler ────────────────────────────────────────────────────────────

// ── dependency probe ────────────────────────────────────────────────────────

/** Sidebar package whose service registers the reader tab. */
const SIDEBAR_PACKAGE = 'dsh-better-sidebar'

/** Harness home, honouring the sandbox override the same way other tools do. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured !== '' ? resolve(configured) : join(homedir(), '.dsh')
}

/** Profile manifests under DSH_HOME/profiles; unreadable entries are skipped. */
async function listProfiles() {
  const root = join(dshHome(), 'profiles')
  let names = []
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const found = []
  for (const profileName of names) {
    try {
      const manifest = JSON.parse(await readFile(join(root, profileName, 'package.json'), 'utf8'))
      found.push({ name: profileName, dir: join(root, profileName), manifest })
    } catch {
      // not a profile directory
    }
  }
  return found
}

/** The profile that owns this plugin: the one listing it as a dependency. */
async function owningProfile() {
  const profiles = await listProfiles()
  if (profiles.length === 0) return undefined
  return profiles.find((profile) => (profile.manifest.dependencies ?? {})[name] !== undefined) ?? profiles[0]
}

/** Bundle layers a profile selects. */
function profileBundles(profile) {
  const bundles = profile?.manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles : []
}

/** Range the plugin pins for the sidebar package. */
async function sidebarRange() {
  try {
    const manifest = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'))
    const range = (manifest.dependencies ?? {})[SIDEBAR_PACKAGE]
    return typeof range === 'string' && range !== '' ? range : 'latest'
  } catch {
    return 'latest'
  }
}

/** How to run the CLI that started this host: command plus leading args. */
function dshCommand() {
  const override = process.env.DSH_BIN
  if (override !== undefined && override !== '' && existsSync(override)) return { cmd: override, prefix: [] }
  const entry = process.argv[1] ?? ''
  if (basename(entry) === 'dsh' && existsSync(entry)) return { cmd: entry, prefix: [] }
  // `dsh web` runs node on the CLI entry, so the same node plus that entry is the CLI.
  if (entry !== '' && existsSync(entry) && /dsh[/\\](lib[/\\])?bin\.js$/.test(entry)) {
    return { cmd: process.execPath, prefix: [entry] }
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'dsh')
    if (existsSync(candidate)) return { cmd: candidate, prefix: [] }
  }
  return undefined
}

/** Sidebar dependency state as the settings page shows it. */
async function depsState() {
  const profile = await owningProfile()
  if (profile === undefined) {
    return { ok: true, deps: { sidebar: { installed: false, mounted: false } }, canInstall: false, reason: 'no-profile' }
  }
  let version = null
  try {
    const manifest = JSON.parse(await readFile(join(profile.dir, 'node_modules', SIDEBAR_PACKAGE, 'package.json'), 'utf8'))
    version = typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    version = null
  }
  const mounted = profileBundles(profile).includes(SIDEBAR_PACKAGE)
  const cli = dshCommand()
  return {
    ok: true,
    deps: { sidebar: { package: SIDEBAR_PACKAGE, installed: version !== null, mounted, version } },
    profile: profile.name,
    canInstall: cli !== undefined && !mounted,
    reason: cli === undefined ? 'no-dsh-command' : null,
  }
}

/** Run one command to completion, keeping the tail of its output. */
function runCommand(cli, args, cwd) {
  return new Promise((settle) => {
    const child = spawn(cli.cmd, [...cli.prefix, ...args], { cwd, env: process.env })
    let output = ''
    const collect = (chunk) => {
      if (output.length < 8000) output += chunk.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ code: -1, output: output + '\n' + String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ code: code ?? -1, output })
    })
  })
}

/** Append the sidebar to the profile's bundle layers when the CLI left it out. */
async function activateBundle(profile) {
  const dependencies = profile.manifest.dependencies ?? {}
  if (dependencies[SIDEBAR_PACKAGE] === undefined) return false
  const manifestPath = join(profile.dir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const dsh = manifest.dsh ?? {}
  const layer = dsh.profile ?? {}
  const bundles = Array.isArray(layer.bundles) ? layer.bundles : []
  if (bundles.includes(SIDEBAR_PACKAGE)) return false
  const updated = {
    ...manifest,
    dsh: { ...dsh, profile: { ...layer, bundles: [...bundles, SIDEBAR_PACKAGE] } },
  }
  await writeFile(manifestPath, JSON.stringify(updated, undefined, 2) + '\n')
  return true
}

/** Install the sidebar through the official CLI so bundle activation runs too. */
async function installSidebar() {
  const profile = await owningProfile()
  if (profile === undefined) return { ok: false, error: 'no profile found' }
  if (profileBundles(profile).includes(SIDEBAR_PACKAGE)) return { ok: true, already: true }
  const cli = dshCommand()
  if (cli === undefined) return { ok: false, error: 'dsh command not found' }
  const spec = `${SIDEBAR_PACKAGE}@${await sidebarRange()}`
  const result = await runCommand(cli, ['plugin', '--profile', profile.name, 'add', spec], profile.dir)
  if (result.code !== 0) return { ok: false, output: result.output.slice(-2000) }
  // The CLI only activates newly added dependencies; an already-declared package
  // still needs its bundle layer, so make that idempotent step explicit.
  await activateBundle(profile)
  return { ok: true, output: result.output.slice(-2000) }
}

/** Write one PDF and its metadata; both the local upload and the link import land here. */
/** Live migration of the paper store between the two storage modes. */
const migration = {
  running: false,
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  from: '',
  to: '',
  error: '',
  startedAt: 0,
  finishedAt: 0,
}

async function movePath(from, to) {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** Target directory for a paper under `mode`, falling back to the import workspace. */
function targetDirFor(meta, mode, cwd) {
  if (mode !== 'workspace') return STORE_DIR
  const workspace = meta.workspace.path !== '' ? meta.workspace.path : cwd
  return workspace === '' ? STORE_DIR : storeDirFor(workspace)
}



async function placeFor(cwd) {
  const settings = await readSettings()
  const clean = typeof cwd === 'string' && cwd.trim() !== '' ? resolve(expandHome(cwd.trim())) : ''
  const workspace = clean === '' ? { path: '', name: '' } : { path: clean, name: basename(clean) }
  if (settings.storage !== 'workspace' || clean === '') return { dir: STORE_DIR, workspace }
  await rememberWorkspaceRoot(clean)
  return { dir: storeDirFor(clean), workspace }
}

async function rememberWorkspaceRoot(path) {
  const settings = await readSettings()
  const listed = Array.from(new Set([...settings.workspaceRoots.map((root) => workspaceOf(root)), path]))
  const collapsed = listed.filter((root) => !listed.some((other) => other !== root && root.startsWith(`${other}${sep}`)))
  if (collapsed.length === settings.workspaceRoots.length && collapsed.every((root, i) => root === settings.workspaceRoots[i])) return
  await writeSettings({ workspaceRoots: collapsed })
}

/**
 * Move every paper into the folder layout of `mode`, one paper at a time so the
 * caller can show progress. Nothing is deleted: a failed move is counted and left
 * in place. The mode itself only flips once every paper has been handled.
 */
async function migrateStorage(mode, cwd) {
  if (migration.running) throw Object.assign(new Error('a migration is already running'), { status: 409 })
  Object.assign(migration, {
    running: true,
    total: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    from: (await readSettings()).storage,
    to: mode,
    error: '',
    startedAt: Date.now(),
    finishedAt: 0,
  })
  try {
    const settings = await readSettings()
    // The target workspace counts as a store even before anything moved there.
    if (mode === 'workspace' && cwd !== '') await rememberWorkspaceRoot(cwd)
    await refreshIndex(true)
    const workRoot = settings.workRoot
    const plan = []
    for (const [id, from] of paperDirs) {
      if (!ID_RE.test(id)) continue
      let meta
      try {
        meta = await readMeta(id)
      } catch {
        continue
      }
      const to = targetDirFor(meta, mode, cwd)
      const folder = mode === 'workspace' ? join(dirname(to), 'papers', slugOf(meta)) : join(workRoot, slugOf(meta))
      if (to !== from || (meta.workDir !== '' && folder !== meta.workDir)) plan.push({ id, from, to, folder, meta })
    }
    migration.total = plan.length
    for (const step of plan) {
      try {
        if (step.to !== step.from) {
          await movePath(join(step.from, `${step.id}.pdf`), join(step.to, `${step.id}.pdf`))
          await movePath(join(step.from, `${step.id}.json`), join(step.to, `${step.id}.json`))
          await movePath(join(step.from, `${step.id}.thumb.jpg`), join(step.to, `${step.id}.thumb.jpg`)).catch(() => {})
          paperDirs.set(step.id, step.to)
        }
        // A recorded folder may already be gone; it never blocks the paper's move.
        if (step.meta.workDir !== '' && step.folder !== step.meta.workDir && existsSync(step.meta.workDir)) {
          await movePath(step.meta.workDir, step.folder).catch(() => {})
        }
        step.meta.store = step.to
        if (mode === 'workspace' && step.meta.workspace.path === '' && cwd !== '') {
          step.meta.workspace = normalizeWorkspace({ path: cwd, name: basename(cwd) })
        }
        if (step.meta.workDir !== '') step.meta.workDir = existsSync(step.folder) ? step.folder : ''
        // Written into the new directory, so a half-moved paper stays readable.
        step.meta.updatedAt = Date.now()
        await writeMeta(step.meta)
        migration.done += 1
      } catch (error) {
        migration.failed += 1
        migration.error = error?.message ?? String(error)
      }
    }
    if (migration.failed === 0) await writeSettings({ storage: mode })
    indexStamp = 0
  } catch (error) {
    migration.error = error?.message ?? String(error)
  } finally {
    migration.running = false
    migration.finishedAt = Date.now()
  }
  return migration
}

async function storePdf(bytes, fileName, requestedTitle, place) {
  const id = randomUUID()
  const target = place !== undefined && typeof place.dir === 'string' ? place.dir : STORE_DIR
  await mkdir(target, { recursive: true })
  paperDirs.set(id, target)
  await writeFile(join(target, `${id}.pdf`), bytes)
  const now = Date.now()
  const title = (requestedTitle.trim() || fileName.replace(/\.pdf$/i, '')).slice(0, 300) || 'paper.pdf'
  const meta = normalizeMeta({
    title,
    fileName,
    size: bytes.length,
    createdAt: now,
    updatedAt: now,
    pageCount: null,
    lastPage: 1,
    scrollRatio: 0,
    annotations: [],
    store: target,
    workspace: place === undefined ? undefined : place.workspace,
  }, id)
  await writeMeta(meta)
  return meta
}

/** Accepts a PDF link; arXiv abstract pages are rewritten to their PDF endpoint. */
function pdfUrlFrom(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.hostname.replace(/^www\./, '') === 'arxiv.org' && url.pathname.startsWith('/abs/')) {
    const id = url.pathname.slice('/abs/'.length).replace(/\/+$/, '')
    return id === '' ? undefined : `https://arxiv.org/pdf/${id}`
  }
  return url.toString()
}

function fileNameFromUrl(url) {
  const path = new URL(url).pathname
  const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '')
  const clean = last.replace(/[^\w.\-]+/g, '_').slice(0, 120)
  if (clean === '') return 'paper.pdf'
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`
}

function titleFromUrl(url) {
  const name = fileNameFromUrl(url)
  const bare = name.replace(/\.pdf$/i, '')
  if (new URL(url).hostname.replace(/^www\./, '') === 'arxiv.org') return `arXiv ${bare}`
  return bare
}

/** Every import path ends here: a real PDF, within the upload budget. */
function assertPdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw Object.assign(new Error('the file is empty'), { status: 400 })
  }
  if (bytes.length > MAX_UPLOAD) {
    throw Object.assign(new Error('the file is larger than 160 MB'), { status: 400 })
  }
  // The header may sit after a few bytes of junk in the wild, so look at the first 1 KB.
  if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw Object.assign(new Error('not a PDF: the file has no %PDF- header'), { status: 400 })
  }
}

async function readLocalPdf(target) {
  const expanded = String(target).trim().replace(/^~(?=$|[\\/])/, homedir())
  const info = await stat(expanded).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    throw Object.assign(new Error(`no such file: ${expanded}`), { status: 400 })
  }
  const bytes = await readFile(expanded)
  assertPdf(bytes)
  return { bytes, fileName: basename(expanded) }
}

async function downloadPdf(target) {
  let response
  try {
    response = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(MAX_IMPORT_MS) })
  } catch (error) {
    throw Object.assign(new Error(`could not download: ${error?.cause?.message ?? error?.message ?? error}`), { status: 502 })
  }
  if (!response.ok) {
    throw Object.assign(new Error(`could not download: HTTP ${response.status}`), { status: 502 })
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_UPLOAD) {
    throw Object.assign(new Error('the file is larger than 160 MB'), { status: 400 })
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  assertPdf(bytes)
  return { bytes, fileName: fileNameFromUrl(target) }
}

/** Remove a paper and everything derived from it (files, parsed text, work folder). */
async function deletePaper(id) {
  let meta
  try {
    meta = await readMeta(id)
  } catch {
    throw Object.assign(new Error(`no such paper: ${id}`), { status: 404 })
  }
  const dir = storeOf(id)
  stopParse(id, 'deleted')
  await unlink(join(dir, `${id}.pdf`)).catch(() => {})
  await unlink(join(dir, `${id}.json`)).catch(() => {})
  await unlink(join(dir, `${id}.thumb.jpg`)).catch(() => {})
  await rm(join(dir, `${id}.md`), { recursive: true, force: true }).catch(() => {})
  paperDirs.delete(id)
  if (meta.workDir !== '') await rm(meta.workDir, { recursive: true, force: true }).catch(() => {})
  return meta
}

async function handleApi(req, res, url, fence) {
  if (!fence(req)) {
    sendError(res, 403, 'forbidden', 'forbidden')
    return true
  }
  const pathname = url.pathname

  if (pathname === '/vibe-reading/api/deps') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    sendJson(res, 200, await depsState())
    return true
  }

  if (pathname === '/vibe-reading/api/deps/install') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const result = await installSidebar()
    if (result.ok !== true) {
      sendError(res, 500, result.error ?? 'install failed', 'install-failed')
      return true
    }
    sendJson(res, 200, { ok: true, already: result.already === true, output: result.output ?? '', deps: (await depsState()).deps })
    return true
  }

  if (pathname === '/vibe-reading/api/workspaces') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    sendJson(res, 200, {
      ok: true,
      storage: (await readSettings()).storage,
      workspaces: await listWorkspaces()
    })
    return true
  }

  if (pathname === '/vibe-reading/api/library') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    sendJson(res, 200, { ok: true, docs: await listLibrary() })
    return true
  }

  if (pathname === '/vibe-reading/api/upload') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const body = await readBody(req, MAX_UPLOAD)
    try {
      assertPdf(body)
    } catch (error) {
      sendError(res, 400, error?.message ?? 'not a PDF file', 'not-pdf')
      return true
    }
    const requestedName = url.searchParams.get('name') ?? ''
    const fileName = requestedName.trim().slice(0, 300) || 'paper.pdf'
    const requestedTitle = (url.searchParams.get('title') ?? '').trim()
    const place = await placeFor(url.searchParams.get('cwd') ?? '')
    const meta = await storePdf(body, fileName, requestedTitle, place)
    sendJson(res, 201, { ok: true, doc: summaryOf(meta) })
    return true
  }

  if (pathname === '/vibe-reading/api/import') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    let payload
    try {
      payload = JSON.parse((await readBody(req, MAX_META_BODY)).toString('utf8') || '{}')
    } catch {
      sendError(res, 400, 'invalid JSON', 'bad-json')
      return true
    }
    const target = pdfUrlFrom(payload.url)
    if (target === undefined) {
      sendError(res, 400, 'only http(s) links are supported', 'bad-url')
      return true
    }
    let fetched
    try {
      fetched = await downloadPdf(target)
    } catch (error) {
      sendError(res, error?.status ?? 502, error?.message ?? String(error), 'download-failed')
      return true
    }
    const place = await placeFor(typeof payload.cwd === 'string' ? payload.cwd : '')
    const meta = await storePdf(fetched.bytes, fetched.fileName, titleFromUrl(target), place)
    sendJson(res, 201, { ok: true, doc: summaryOf(meta) })
    return true
  }

  if (pathname === '/vibe-reading/api/doc') {
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    if (req.method === 'GET') {
      try {
        const meta = await readMeta(id)
        const markdown = await markdownState(meta)
        sendJson(res, 200, { ok: true, doc: { ...meta, hasMarkdown: markdown.exists, markdownHasImages: markdown.hasImages } })
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
      }
      return true
    }
    if (req.method === 'PATCH') {
      let meta
      try {
        meta = await readMeta(id)
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
        return true
      }
      const body = JSON.parse((await readBody(req, MAX_META_BODY)).toString('utf8') || '{}')
      await appendFile(join(STORE_DIR, 'telemetry.jsonl'), JSON.stringify({
        at: new Date().toISOString(),
        kind: 'patch',
        id,
        keys: Object.keys(body),
        annots: Array.isArray(body.annotations) ? body.annotations.length : null,
        notes: Array.isArray(body.paperNotes) ? body.paperNotes.length : null
      }) + '\n').catch(() => {})
      if (typeof body.title === 'string' && body.title.trim() !== '') meta.title = body.title.trim().slice(0, 300)
      if (Number.isInteger(body.pageCount) && body.pageCount > 0) meta.pageCount = body.pageCount
      if (Number.isInteger(body.lastPage) && body.lastPage > 0) meta.lastPage = body.lastPage
      if (Number.isFinite(body.scrollRatio)) meta.scrollRatio = Math.min(Math.max(body.scrollRatio, 0), 1)
      if (Array.isArray(body.paperNotes)) {
        meta.paperNotes = body.paperNotes.map(normalizePaperNote).filter(Boolean).slice(0, MAX_PAPER_NOTES)
      }
      if (Array.isArray(body.annotations)) {
        // Guard: an empty list from a client that never loaded the annotations
        // would erase them for everyone. Deleting the last one must say so.
        if (body.annotations.length === 0 && meta.annotations.length > 0 && body.allowEmpty !== true) {
          await appendFile(join(STORE_DIR, 'telemetry.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'patch-blocked-empty', id, kept: meta.annotations.length }) + '\n').catch(() => {})
          body.annotations = meta.annotations
        }
        meta.annotations = body.annotations
          .slice(0, MAX_ANNOTATIONS)
          .map(normalizeAnnotation)
          .filter(Boolean)
      }
      if (body.code !== null && typeof body.code === 'object') meta.code = normalizeCode(body.code)
      if (body.workspace !== undefined) {
        const next = normalizeWorkspace(body.workspace)
        if (next.path !== meta.workspace.path) {
          meta.workspace = next
          await relocatePaper(meta, id)
        }
      }
      meta.updatedAt = Date.now()
      await writeMeta(meta)
      if (Array.isArray(body.annotations) || Array.isArray(body.paperNotes)) await syncPaperNotes(meta)
      sendJson(res, 200, { ok: true, doc: summaryOf(meta) })
      return true
    }
    if (req.method === 'DELETE') {
      const removed = await deletePaper(id).catch(() => undefined)
      if (removed === undefined) {
        sendError(res, 404, 'paper not found', 'not-found')
        return true
      }
      sendJson(res, 200, { ok: true })
      return true
    }
    sendError(res, 405, 'method not allowed', 'method-error')
    return true
  }

  if (pathname === '/vibe-reading/api/telemetry') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const raw = (await readBody(req, 16 * 1024)).toString('utf8')
    let entry = null
    try { entry = JSON.parse(raw) } catch { entry = { raw: raw.slice(0, 400) } }
    await appendFile(join(STORE_DIR, 'telemetry.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n').catch(() => {})
    sendJson(res, 200, { ok: true })
    return true
  }

  if (pathname === '/vibe-reading/api/version') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8').catch(() => '{}'))
    const version = typeof pkg.version === 'string' ? pkg.version : ''
    await appendFile(join(STORE_DIR, 'telemetry.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'version', version }) + '\n').catch(() => {})
    sendJson(res, 200, { ok: true, version })
    return true
  }

  if (pathname === '/vibe-reading/api/skill') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    sendJson(res, 200, { ok: true, skill: { name: PAPER_SKILL_NAME, description: PAPER_SKILL_DESCRIPTION, content: PAPER_SKILL_BODY } })
    return true
  }

  if (pathname === '/vibe-reading/api/storage/migrate') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, migration })
      return true
    }
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    let payload
    try {
      payload = JSON.parse((await readBody(req, MAX_META_BODY)).toString('utf8') || '{}')
    } catch {
      sendError(res, 400, 'invalid JSON', 'bad-json')
      return true
    }
    const mode = payload.storage === 'workspace' ? 'workspace' : 'global'
    try {
      const done = await migrateStorage(mode, typeof payload.cwd === 'string' ? payload.cwd : '')
      sendJson(res, 200, { ok: done.failed === 0, migration: done })
    } catch (error) {
      sendError(res, error?.status ?? 500, error?.message ?? String(error), 'migrate-failed')
    }
    return true
  }

  // A running migration owns every file under the paper folders.
  if (migration.running && !pathname.startsWith('/vibe-reading/static')) {
    sendError(res, 409, 'storage migration in progress', 'migrating')
    return true
  }

  if (pathname === '/vibe-reading/api/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, settings: publicSettings(await readSettings()) })
      return true
    }
    if (req.method === 'PATCH') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
      // The storage mode moves files; it only changes through /storage/migrate.
      if (body.storage !== undefined) {
        sendError(res, 409, 'change storage through /vibe-reading/api/storage/migrate', 'use-migrate')
        return true
      }
      const next = await writeSettings(body)
      sendJson(res, 200, { ok: true, settings: publicSettings(next) })
      return true
    }
    sendError(res, 405, 'method not allowed', 'method-error')
    return true
  }

  if (pathname === '/vibe-reading/api/parse') {
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    if (req.method === 'GET') {
      try {
        sendJson(res, 200, { ok: true, parse: await parseStateOf(id) })
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
      }
      return true
    }
    if (req.method === 'POST') {
      const engine = url.searchParams.get('engine') === 'mineru' ? 'mineru' : 'markdown'
      if (engine === 'mineru') {
        const settings = await readSettings()
        if (settings.mineruApiKey === '') {
          sendError(res, 400, 'MinerU API key is not configured', 'no-key')
          return true
        }
      }
      try {
        await stat(pdfPath(id))
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
        return true
      }
      sendJson(res, 202, { ok: true, parse: startParse(id, engine) })
      return true
    }
    sendError(res, 405, 'method not allowed', 'method-error')
    return true
  }

  if (pathname === '/vibe-reading/api/paperdir') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    try {
      sendJson(res, 200, { ok: true, folder: await paperBrief(id) })
    } catch {
      sendError(res, 404, 'paper not found', 'not-found')
    }
    return true
  }

  if (pathname === '/vibe-reading/api/translate') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    let body
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
    } catch {
      sendError(res, 400, 'body must be JSON', 'bad-body')
      return true
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') {
      sendError(res, 400, 'nothing to translate', 'empty-text')
      return true
    }
    if (text.length > 6000) {
      sendError(res, 413, 'selection too long (6000 characters max)', 'too-long')
      return true
    }
    const target = body.target === 'en' ? 'en' : 'zh'
    try {
      const result = await translatePassage(text, target)
      sendJson(res, 200, { ok: true, text: result.text, target, provider: result.provider, model: result.model })
    } catch (error) {
      sendError(res, Number.isInteger(error?.status) ? error.status : 500, error?.message ?? String(error), 'translate-failed')
    }
    return true
  }

  if (pathname === '/vibe-reading/api/compact') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    try {
      const result = await compactPaperCopies()
      sendJson(res, 200, { ok: true, linked: result.linked.length, bytes: result.bytes })
    } catch (error) {
      sendError(res, 500, error?.message ?? String(error), 'compact-failed')
    }
    return true
  }

  if (pathname === '/vibe-reading/api/code') {
    if (req.method === 'GET') {
      const id = docId(url.searchParams.get('id'))
      if (id === undefined) {
        sendError(res, 400, 'missing or invalid paper id', 'bad-id')
        return true
      }
      try {
        const meta = await readMeta(id)
        sendJson(res, 200, { ok: true, code: meta.code })
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
      }
      return true
    }
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    let body
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
    } catch {
      sendError(res, 400, 'body must be JSON', 'bad-body')
      return true
    }
    const id = docId(body.id)
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    try {
      const action = typeof body.action === 'string' ? body.action : 'repo'
      if (action === 'clone') {
        const typed = typeof body.repo === 'string' ? body.repo.trim() : ''
        if (typed !== '') {
          const current = await readMeta(id)
          if (typed !== current.code.repo) {
            if (!/^https?:\/\//i.test(typed)) throw Object.assign(new Error('repo must be an http(s) URL'), { status: 400 })
            current.code = normalizeCode({ ...current.code, repo: typed, clone: { status: 'idle', message: '', startedAt: 0, finishedAt: 0 } })
            current.updatedAt = Date.now()
            await writeMeta(current)
          }
        }
        sendJson(res, 200, { ok: true, clone: await startClone(id), folder: await paperBrief(id) })
        return true
      }
      const meta = await readMeta(id)
      const repo = typeof body.repo === 'string' ? body.repo.trim() : meta.code.repo
      if (repo !== '' && !/^https?:\/\//i.test(repo)) throw Object.assign(new Error('repo must be an http(s) URL'), { status: 400 })
      const reset = repo !== meta.code.repo
      meta.code = normalizeCode({ ...meta.code, repo, clone: reset ? { status: 'idle', message: '', startedAt: 0, finishedAt: 0 } : meta.code.clone })
      meta.updatedAt = Date.now()
      await writeMeta(meta)
      sendJson(res, 200, { ok: true, folder: await paperBrief(id) })
    } catch (error) {
      sendError(res, Number.isInteger(error?.status) ? error.status : 500, error?.message ?? String(error), 'code-failed')
    }
    return true
  }

  if (pathname === '/vibe-reading/api/tree') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    try {
      sendJson(res, 200, { ok: true, listing: await listDirectory(url.searchParams.get('path') ?? '') })
    } catch (error) {
      sendError(res, Number.isInteger(error?.status) ? error.status : 400, error?.message ?? String(error), 'bad-path')
    }
    return true
  }

  if (pathname === '/vibe-reading/file') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    let meta
    try {
      meta = await readMeta(id)
    } catch {
      sendError(res, 404, 'paper not found', 'not-found')
      return true
    }
    let info
    try {
      info = await stat(pdfPath(id))
    } catch {
      sendError(res, 404, 'paper file not found', 'not-found')
      return true
    }
    const encoded = encodeURIComponent(meta.fileName || `${meta.title}.pdf`)
    serveFile(req, res, pdfPath(id), info.size, 'application/pdf', {
      'content-disposition': `inline; filename*=UTF-8''${encoded}`,
    })
    return true
  }

  if (pathname === '/vibe-reading/thumb') {
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    if (req.method === 'POST') {
      let bytes
      try {
        bytes = await readBody(req, 512 * 1024)
      } catch (error) {
        sendError(res, Number.isInteger(error?.status) ? error.status : 400, error?.message ?? String(error), 'bad-body')
        return true
      }
      // A thumbnail is a JPEG or it is nothing; anything else is a bad client.
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        sendError(res, 400, 'thumbnail must be a jpeg', 'bad-image')
        return true
      }
      await writeFile(thumbPath(id), bytes).catch((error) => {
        sendError(res, 500, error?.message ?? String(error), 'write-failed')
      })
      sendJson(res, 200, { ok: true, bytes: bytes.length })
      return true
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    let info
    try {
      info = await stat(thumbPath(id))
    } catch {
      sendError(res, 404, 'no thumbnail', 'not-found')
      return true
    }
    serveFile(req, res, thumbPath(id), info.size, 'image/jpeg', {
      'cache-control': 'public, max-age=31536000, immutable',
    })
    return true
  }

  if (pathname.startsWith('/vibe-reading/static/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    let relative
    try {
      relative = decodeURIComponent(pathname.slice('/vibe-reading/static/'.length))
    } catch {
      sendError(res, 400, 'bad path', 'bad-path')
      return true
    }
    const target = resolve(PUBLIC_DIR, relative)
    if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
      sendError(res, 403, 'forbidden', 'forbidden')
      return true
    }
    let info
    try {
      info = await stat(target)
    } catch {
      sendError(res, 404, 'not found', 'not-found')
      return true
    }
    if (!info.isFile()) {
      sendError(res, 404, 'not found', 'not-found')
      return true
    }
    serveFile(req, res, target, info.size, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream')
    return true
  }

  sendError(res, 404, 'unknown route', 'not-found')
  return true
}

// ── model-facing annotation tool ─────────────────────────────────────────────

const ANNOTATION_TOOL_DESCRIPTION = [
  "Read and write one paper's annotations, highlights and paper-level notes; they are the durable shared memory of what was read.",
  'action="list" without docId lists the library; with docId it returns that paper\'s paths (pdf / markdown / code), annotations and notes — call it first to see whether the paper was already read.',
  'action="search" looks for text across every paper\'s annotations and notes (pass docId to narrow it) — use it before reading to reuse what was already written.',
  'action="create" appends annotations, either one (page/text/note/kind) or a batch via items; text is the quoted passage, note is the judgement.',
  'action="update"/"delete" change one annotation by id; action="note"/"update_note"/"delete_note" manage paper-level notes (write one note per block — 论文简介 / 方法骨架 / 关键证据 / 正反辩论 / 怎么用 / 已读 — each with its title).',
  'action="code" reads or records the open-source repository; the checkout itself lands in the paper folder\'s remote/ through the reader UI.',
  'action="keywords" stores 3-6 domain keywords and, when title is given, the concise paper title shown on the library card; run it after reading.',
  'action="import" adds a paper from a local PDF path or an http(s) link (arXiv abs links are rewritten to pdf); every import is checked for a %PDF- header and the 160 MB limit before it is stored.',
  'action="rename" changes a paper\'s title or keywords; action="delete" removes a paper together with its work folder (pdf, markdown, notes, code) — do that only when the user asks for it.',
].join(' ')

function toolText(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 60000) }]
}

/** 3-8 short domain keywords from an array or a comma-separated string. */
function normalizeKeywords(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、]/) : []
  return raw
    .filter((word) => typeof word === 'string')
    .map((word) => word.trim().slice(0, 24))
    .filter((word) => word !== '')
    .slice(0, 8)
}

async function runAnnotationTool(args, exec) {
  if (migration.running) {
    throw Object.assign(new Error('storage migration in progress; retry when it finishes'), { status: 409 })
  }
  const action = typeof args.action === 'string' ? args.action : 'list'

  if (action === 'import') {
    const title = typeof args.title === 'string' ? args.title : ''
    let fetched
    let suggested = title
    if (typeof args.path === 'string' && args.path.trim() !== '') {
      fetched = await readLocalPdf(args.path)
    } else if (typeof args.url === 'string' && args.url.trim() !== '') {
      const target = pdfUrlFrom(args.url)
      if (target === undefined) {
        throw Object.assign(new Error('only http(s) links are supported'), { status: 400 })
      }
      fetched = await downloadPdf(target)
      if (suggested.trim() === '') suggested = titleFromUrl(target)
    } else {
      throw Object.assign(new Error('import needs path (a local PDF file) or url'), { status: 400 })
    }
    const cwd = exec !== null && typeof exec === 'object'
      ? (typeof exec.cwd === 'string' ? exec.cwd : (exec.session !== null && typeof exec.session === 'object' && typeof exec.session.cwd === 'string' ? exec.session.cwd : ''))
      : ''
    const meta = await storePdf(fetched.bytes, fetched.fileName, suggested, await placeFor(cwd))
    return { ok: true, doc: summaryOf(meta) }
  }

  // `delete` with an annotation id removes that annotation; without one it removes the paper.
  if (action === 'delete' && (args.id === undefined || args.id === '')) {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('delete needs a docId (paper) or an id (annotation)'), { status: 400 })
    const removed = await deletePaper(id)
    return { ok: true, docId: id, removed: removed.title }
  }

  if (action === 'rename') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('rename needs a docId'), { status: 400 })
    const meta = await readMeta(id)
    if (typeof args.title === 'string' && args.title.trim() !== '') {
      meta.title = args.title.trim().replace(/\s+/g, ' ').slice(0, 160)
    }
    if (args.keywords !== undefined) meta.keywords = normalizeKeywords(args.keywords)
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await paperBrief(id).catch(() => {})
    return { ok: true, docId: id, title: meta.title, keywords: meta.keywords }
  }

  if (action === 'list') {
    const id = docId(args.docId)
    if (id === undefined) {
      const docs = await listLibrary()
      return {
        ok: true,
        papers: docs.map((doc) => ({
          docId: doc.id,
          title: doc.title,
          pageCount: doc.pageCount,
          highlights: doc.highlightCount,
          notes: doc.noteCount,
          aiNotes: doc.aiCount,
          parseStatus: doc.parseStatus,
          keywords: doc.keywords,
        })),
      }
    }
    const meta = await readMeta(id)
    const page = Number.isInteger(args.page) ? args.page : 0
    const annotations = meta.annotations
      .filter((annotation) => page === 0 || annotation.page === page)
      .map((annotation) => ({
        id: annotation.id,
        page: annotation.page,
        kind: annotation.kind,
        author: annotation.author,
        text: annotation.text.slice(0, 2000),
        note: annotation.note.slice(0, 4000),

        createdAt: annotation.createdAt,
      }))
    const brief = await paperBrief(id)
    return {
      ok: true,
      docId: id,
      title: meta.title,
      pageCount: meta.pageCount,
      code: meta.code,
      keywords: meta.keywords,
      paths: brief === undefined ? null : { dir: brief.path, pdf: brief.pdf, markdown: brief.markdown, code: brief.code },
      annotations,
      notes: meta.paperNotes.map((note) => ({
        id: note.id,
        title: note.title,
        text: note.text,
        author: note.author,
        updatedAt: note.updatedAt,
      })),
    }
  }

  if (action === 'search') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (query === '') throw Object.assign(new Error('search needs query'), { status: 400 })
    const id = docId(args.docId)
    const metas = id === undefined ? await Promise.all((await listLibrary()).map((doc) => readMeta(doc.id))) : [await readMeta(id)]
    const needle = query.toLowerCase()
    const hits = []
    for (const meta of metas) {
      for (const annotation of meta.annotations) {
        if ((annotation.text + '\n' + annotation.note).toLowerCase().includes(needle)) {
          hits.push({
            type: 'annotation',
            docId: meta.id,
            paperTitle: meta.title,
            id: annotation.id,
            page: annotation.page,
            kind: annotation.kind,
            author: annotation.author,
            text: annotation.text.slice(0, 400),
            note: annotation.note.slice(0, 600),
          })
        }
      }
      for (const note of meta.paperNotes) {
        if (note.text.toLowerCase().includes(needle)) {
          hits.push({
            type: 'note',
            docId: meta.id,
            paperTitle: meta.title,
            id: note.id,
            title: note.title,
            author: note.author,
            text: note.text.slice(0, 800),
          })
        }
      }
    }
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 60
    return { ok: true, query, total: hits.length, hits: hits.slice(0, limit) }
  }

  if (action === 'create') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('create needs a docId from action="list"'), { status: 400 })
    const items = Array.isArray(args.items) ? args.items : []
    const batch = items.length > 0 ? items : [{ page: args.page, text: args.text, note: args.note, kind: args.kind }]
    if (batch.length > 200) throw Object.assign(new Error(`create accepts at most ${MAX_ANNOTATIONS} items`), { status: 400 })
    const meta = await readMeta(id)
    const now = Date.now()
    const created = []
    const skipped = []
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index]
      if (item === null || typeof item !== 'object') {
        skipped.push({ index, reason: 'not an object' })
        continue
      }
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      const note = typeof item.note === 'string' ? item.note.trim() : ''
      if (text === '' && note === '') {
        skipped.push({ index, reason: 'needs text or note' })
        continue
      }
      if (meta.annotations.length >= MAX_ANNOTATIONS) {
        skipped.push({ index, reason: 'annotation limit reached' })
        continue
      }
      const page = Number.isInteger(item.page) && item.page > 0 ? Math.min(item.page, meta.pageCount ?? item.page) : 1
      const annotation = normalizeAnnotation({
        kind: item.kind === 'highlight' ? 'highlight' : 'note',
        page,
        text,
        note,
        color: '',
        author: 'ai',
        createdAt: now,
        updatedAt: now,
      })
      if (annotation === undefined) {
        skipped.push({ index, reason: 'could not be normalized' })
        continue
      }
      meta.annotations.push(annotation)
      created.push({ id: annotation.id, page: annotation.page, kind: annotation.kind, text: annotation.text.slice(0, 60) })
    }
    if (created.length === 0) {
      const reasons = skipped.map((entry) => `#${entry.index}: ${entry.reason}`).join('; ')
      throw Object.assign(new Error(`nothing created — ${reasons}`), { status: 400 })
    }
    meta.updatedAt = now
    await writeMeta(meta)
    await syncPaperNotes(meta)
    return { ok: true, docId: id, created, skipped }
  }

  if (action === 'note') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('note needs a docId'), { status: 400 })
    const text = typeof args.note === 'string' ? args.note.trim() : ''
    if (text === '') throw Object.assign(new Error('note needs note text'), { status: 400 })
    const meta = await readMeta(id)
    if (meta.paperNotes.length >= MAX_PAPER_NOTES) throw Object.assign(new Error('note limit reached'), { status: 409 })
    const now = Date.now()
    const note = normalizePaperNote({
      title: typeof args.title === 'string' ? args.title.trim() : '',
      text,
      author: 'ai',
      createdAt: now,
      updatedAt: now,
    })
    meta.paperNotes.push(note)
    meta.updatedAt = now
    await writeMeta(meta)
    await syncPaperNotes(meta)
    return { ok: true, docId: id, created: { id: note.id, text: note.text } }
  }

  if (action === 'update_note' || action === 'delete_note') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('needs a docId'), { status: 400 })
    const noteId = typeof args.id === 'string' ? args.id : ''
    const meta = await readMeta(id)
    const index = meta.paperNotes.findIndex((note) => note.id === noteId)
    if (index < 0) throw Object.assign(new Error(`no note ${noteId}`), { status: 404 })
    if (action === 'delete_note') {
      meta.paperNotes.splice(index, 1)
    } else {
      const text = typeof args.note === 'string' ? args.note.trim() : ''
      if (text === '') throw Object.assign(new Error('update_note needs note text'), { status: 400 })
      const title = typeof args.title === 'string' ? args.title.trim().slice(0, 48) : meta.paperNotes[index].title
      meta.paperNotes[index] = { ...meta.paperNotes[index], title, text: text.slice(0, MAX_NOTE_CHARS), updatedAt: Date.now() }
    }
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await syncPaperNotes(meta)
    return { ok: true, docId: id, notes: meta.paperNotes }
  }

  if (action === 'keywords') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('keywords needs a docId'), { status: 400 })
    const meta = await readMeta(id)
    const words = normalizeKeywords(args.keywords)
    meta.keywords = words
    // The library card shows the title, and a file-name title ("1706.03762v1") says
    // nothing; the same call that files the keywords rewrites it to the real one.
    const title = typeof args.title === 'string' ? args.title.trim().replace(/\s+/g, ' ') : ''
    if (title !== '') meta.title = title.slice(0, 160)
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await paperBrief(id).catch(() => {})
    return { ok: true, docId: id, keywords: words, title: meta.title }
  }

  if (action === 'code') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('code needs a docId'), { status: 400 })
    const meta = await readMeta(id)
    const repo = typeof args.repo === 'string' ? args.repo.trim() : ''
    if (repo === '') {
      return { ok: true, docId: id, title: meta.title, pageCount: meta.pageCount, code: meta.code }
    }
    if (!/^https?:\/\//i.test(repo)) {
      throw Object.assign(new Error('repo must be an http(s) URL'), { status: 400 })
    }
    const reset = repo !== meta.code.repo
    meta.code = normalizeCode({ ...meta.code, repo, clone: reset ? { status: 'idle', message: '', startedAt: 0, finishedAt: 0 } : meta.code.clone })
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await paperBrief(id).catch(() => {})
    return { ok: true, docId: id, title: meta.title, code: meta.code }
  }

  if (action === 'update' || action === 'delete') {
    const id = docId(args.docId)
    const annotationId = typeof args.id === 'string' ? args.id : ''
    if (id === undefined || annotationId === '') throw Object.assign(new Error(`${action} needs docId and id`), { status: 400 })
    const meta = await readMeta(id)
    const index = meta.annotations.findIndex((annotation) => annotation.id === annotationId)
    if (index === -1) throw Object.assign(new Error('annotation not found'), { status: 404 })
    if (action === 'delete') {
      meta.annotations.splice(index, 1)
    } else {
      const target = meta.annotations[index]
      if (typeof args.note === 'string') target.note = args.note.slice(0, 20000)
      if (typeof args.text === 'string' && args.text.trim() !== '') target.text = args.text.slice(0, 20000)
      target.updatedAt = Date.now()
    }
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await syncPaperNotes(meta)
    return { ok: true, docId: id, id: annotationId }
  }

  throw Object.assign(new Error(`unknown action: ${action}`), { status: 400 })
}

function registerAnnotationTool(ctx) {
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get('tools')
    if (tools === undefined || typeof tools.register !== 'function') return
    const definition = {
      name: 'vibe_reading',
      description: ANNOTATION_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'search', 'create', 'update', 'delete', 'import', 'rename', 'code', 'keywords', 'note', 'update_note', 'delete_note'],
            description: "list papers, one paper's annotations and its notes; create/update/delete an annotation; note/update_note/delete_note manage paper-level notes; import/rename/delete manage the library itself", 
          },
          docId: { type: 'string', description: 'paper id from action="list"' },
          path: { type: 'string', description: 'for action="import": absolute or ~ path of a local PDF file' },
          url: { type: 'string', description: 'for action="import": http(s) link to a PDF; an arXiv abs link is rewritten to its pdf endpoint' },
          query: { type: 'string', description: 'for action="search": case-insensitive text to look for in annotations and notes' },
          keywords: {
            type: 'array',
            description: 'for action="keywords": 3-6 domain keywords that place this paper in a field; replaces the stored list',
            items: { type: 'string' },
          },
          limit: { type: 'integer', description: 'for action="search": max hits, default 60' },
          id: { type: 'string', description: 'annotation id, for update/delete' },
          page: { type: 'integer', description: '1-based page number' },
          items: {
            type: 'array',
            description: 'for action="create": write several annotations in one call',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer', description: '1-based page number' },
                text: { type: 'string', description: 'the quoted passage, <=200 chars' },
                note: { type: 'string', description: 'your judgement on that passage, one sentence' },
                kind: { type: 'string', enum: ['note', 'highlight'] },
              },
              required: ['page'],
              additionalProperties: false,
            },
          },
          kind: { type: 'string', enum: ['note', 'highlight'], description: 'annotation kind, defaults to note' },
          repo: { type: 'string', description: 'for action="code": open-source repository URL of this paper\'s implementation' },
          text: { type: 'string', description: 'the quoted passage the annotation is about' },
          note: { type: 'string', description: 'the annotation body, or the paper-level note text, written in the user\'s language and kept to one sentence' },
          title: { type: 'string', description: 'for note/update_note: the block heading, e.g. 论文简介 / 方法骨架 / 关键证据 / 正反辩论 / 怎么用 / 已读; for keywords: the concise paper title that replaces the file-name title on the library card' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            papers: { type: 'array', items: { type: 'object', additionalProperties: true } },
            annotations: { type: 'array', items: { type: 'object', additionalProperties: true } },
            created: { type: 'array', items: { type: 'object', additionalProperties: true } },
            skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
            hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          additionalProperties: true,
        },
        render: (_args, value) => toolText(value),
      },
      execute: (args, exec) => runAnnotationTool(args, exec),
    }
    try {
      toolCtx.effect(() => tools.register(definition))
    } catch (error) {
      // A deployment without the tools service still keeps every HTTP route.
      toolCtx.logger?.warn?.('vibe_reading tool not registered: %s', error?.message ?? error)
    }
  })
}

// ── the skill that teaches cross-session paper memory ────────────────────────

const PAPER_SKILL_NAME = 'dsh-vibe-reading'

const PAPER_SKILL_DESCRIPTION = '读一篇论文并把它读成标注与笔记：已读判断、逐节标注、论文级大笔记的完整工作流。'

const PAPER_SKILL_BODY = `# 论文阅读：把读到的内容写进标注与笔记

每篇论文的工作目录固定这几样，先按目录读，不要凭记忆猜内容：

- \`meta.md\`：元信息——页数、领域关键词、仓库地址与克隆状态、解析状态、各目录内容计数。**必有**，先读它。
- \`notes.md\`：标注与笔记的唯一文档，按「## 笔记 / ## 标注」分块，每次改动自动重写。
- \`markdown/paper.md\`：解析正文，可能带 \`images/\`。
- \`remote/\`：克隆下来的开源实现，可能是空的。
- \`local/\`：本地复现代码（论文没开源、或自己想改一版时放这里），默认空。
- \`pdf/\`：原始 PDF。

路径一律以 \`list\` 返回的 \`paths\` 为准——论文可能在全局库，也可能在当前工作区的 \`.vibe_reading/\`（设置里的「跟随工作区」）。

## 一、先查已读，再决定读不读

1. \`list\`（不带 docId）：拿到 docId、页数、标注与笔记数量。
2. \`list\`（带 docId）：读全部 annotations、notes 与 paths。
   要找「以前在哪篇写过 X」：\`search\` + \`query\`，命中会给 docId、页码与原文。
3. 判定已读：notes 里有「已读」那条，且它覆盖了你要回答的章节与页码。
   - 已读且覆盖：直接用标注与笔记回答，附页码，**不重读**。
   - 只覆盖一部分：只补缺的章节，不从第一页重来。
   - 没读过：走下面的完整流程。

用户要加论文、改标题、删论文时你自己动手（\`import\` / \`rename\` / \`delete\`），不要让他去点界面；删除只在用户明确说要删时做，删完说清删的是哪篇。

## 二、读

读 \`paths.markdown\`；没有 markdown 就提示用户在阅读器里点解析，或按 PDF 页读。
要看实现：先 \`ls remote/\`，空就看 \`local/\`；两边都空只说明还没人放代码，别当成论文没有实现。
克隆到 \`remote/\` 由阅读器面板的「克隆」按钮发起，不要手动往 \`remote/\` 里拷文件。
按节推进：摘要 → 引言 → 方法 → 实验 → 局限与结论。**每节读完立刻落标注**，不要攒到最后一起写。
关键图（架构图、主结果、消融）在 \`markdown/images/\` 里，读到图所在小节时单独看一遍再标；公式与表格的数字直接引用原文。

## 三、标注：细节索引

每条锚在它说的那一页（PDF 页码，不是 markdown 行号）。
- \`text\`：原文引句，挑能自证的那句。
- \`note\`：你的判断，一句话、不超过 40 字，写「这说明了什么」，不写「作者写了什么」。
- \`kind\`：\`highlight\` 用于能选中的正文；\`note\` 用于页级观察（图表、页边结论）。
- 覆盖面：每节 1–3 条；方法的关键步骤、实验的关键数字与对照组必须有。
- 一条结论对应一条标注，不重复标同一处。

多条用 \`items\` 一次提交 5–10 条，比一条一调省往返。

不标：目录、致谢、纯背景铺垫、同一结论的重复表述。

## 四、大笔记：按块写，一篇论文一组

读完立刻写，**一块一条**（\`title\` 填块名，正文不要再重复块名），六块齐全：

1. **【论文简介】** 解决什么问题、用什么方法、结论有多强（真机？大规模？单一任务？）。
2. **【方法骨架】** 3–5 步或模块，写清输入输出与依赖顺序；关键设计选择说清为什么这么做。
3. **【关键证据】** 支撑结论的实验与数字：对照对象、指标、提升幅度、失效条件。
4. **【正反辩论】** 2–4 组，每组三行：\`正方：…\` / \`反方：…\` / \`裁决：…\`。
   - 问题钉在具体设计或数字上，不写「方法是否通用」这类空话。
   - 反方要能扎人：指假设漏洞、实验缺失、隐性优势、替代解释。
   - 裁决给条件性结论：在什么条件下正方成立，什么条件下反方占优。
5. **【怎么用】** 可复用点、和当前工作的接口、需要自己验证的地方。
6. **【已读】** \`已读 p1-pN；覆盖 X 节；未读 附录\`——下次靠它判断要不要重读。

每条 2–5 句。大笔记不是摘要：写判断与取舍，让没读过的人也能据此行动。
标注与笔记都落进 \`notes.md\`——那是这篇论文唯一的可读文档，别在别处再存一份。
同一篇论文只有这一组：有新认识就改对应那块，某块彻底作废就删掉，不要留空壳。

## 五、关键词与标题：让这篇论文可被认出

读完（标注与大笔记都落好）再跑一次 \`keywords\`，一次给两样：

- \`keywords\`：3–6 个词，大领域 + 子方向 + 任务或数据名，例如 \`["VLA", "推理运行时", "Roofline", "机器人策略"]\`。
- \`title\`：论文的简洁标题——取原文主标题，去掉 arXiv 编号、版本号与「Preprint」之类的尾巴，副标题太长就砍掉；中文论文保留原中文标题，不要自己翻译。

\`title\` 会替换论文库卡片上那个从文件名来的临时名字（例如 \`1706.03762v1\`）；不传就只更新关键词。
两项都显示在论文库卡片上，也是 \`search\` 之外找论文的入口。写完再回答用户。

## 六、回答

细节问题先查标注与大笔记，不够再回原文补。答案里带页码，用户在阅读器里能直接点过去。

## 不该做

- 只写 40 字的大笔记——大笔记要能撑起整篇判断。
- 每段都标（噪音），或标了却不写 note（等于没读）。
- 已覆盖的章节反复读、重复写。
`;

/** Advertise the cross-session memory skill from this plugin's own runtime. */
function registerPaperSkill(ctx) {
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => skillCtx.skills.register({
      name: PAPER_SKILL_NAME,
      description: PAPER_SKILL_DESCRIPTION,
      whenToUse: '读论文、写论文标注或笔记、跨会话接着上次的结论继续时',
      // A loaded skill requires a string source; the registry keeps the provider
      // label separate, so name the origin bucket explicitly.
      source: 'runtime',
      content: PAPER_SKILL_BODY,
    }))
  })
}

// ── plugin body ──────────────────────────────────────────────────────────────


/** Handles for the one-shot translation call; filled while the plugin mounts. */
let llmService = null
let defaultModelService = null

const TRANSLATE_SYSTEM = {
  zh: '你翻译学术论文。把用户给的这段文字译成简体中文，只输出译文本身：不要解释、不要加引号、不要保留原文。公式、变量名、代码标识符、引用编号原样保留；术语用领域通行译法。',
  en: 'You translate research papers. Turn the user text into English and output the translation only: no explanation, no quotes, no source text. Keep formulas, variable names, code identifiers and citation numbers as they are; use the field’s usual terminology.',
}

/** Translate one passage with the model the session already uses. */
async function translatePassage(text, target) {
  if (llmService === null) throw Object.assign(new Error('model service unavailable'), { status: 503 })
  if (defaultModelService === null) throw Object.assign(new Error('no default model configured'), { status: 503 })
  const selection = defaultModelService.currentSelection()
  if (selection === null || selection === undefined) {
    throw Object.assign(new Error('no default model configured'), { status: 503 })
  }
  let out = ''
  let failure = null
  for await (const chunk of llmService.stream({
    provider: selection.provider,
    model: selection.model,
    system: TRANSLATE_SYSTEM[target],
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    maxTokens: 2000,
    signal: AbortSignal.timeout(60_000),
  })) {
    if (chunk.type === 'text-delta') out += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      failure = chunk.reason.failure
    }
  }
  if (failure !== null) {
    throw Object.assign(new Error(failure?.message ?? 'model call failed'), { status: 502 })
  }
  const value = out.trim()
  if (value === '') throw Object.assign(new Error('empty translation'), { status: 502 })
  return { text: value, provider: selection.provider, model: selection.model }
}

export function apply(ctx) {
  const trustedHosts = ctx.webStartup.trustedHosts ?? []
  ctx.inject(['llm'], (scoped) => {
    llmService = scoped.llm
  })
  ctx.inject(['agentDefaultModel'], (scoped) => {
    defaultModelService = scoped.agentDefaultModel
  })
  registerAnnotationTool(ctx)
  registerPaperSkill(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/vibe-reading',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        await handleApi(req, res, url, (request) => isTrustedApiRequest(request, trustedHosts))
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        sendError(res, status, error?.message ?? String(error))
      }
    },
  }))
}
