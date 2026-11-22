import { spawn } from 'node:child_process'

const textExtensions = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'yaml', 'yml', 'toml'])
const maxTextBytes = 64 * 1024
const maxPromptBytes = 128 * 1024
const maxPDFBytes = 16 * 1024 * 1024

function* parts(content) {
  if (!Array.isArray(content)) return
  for (const part of content) {
    yield part
    if (part.type === 'tool-result') yield* parts(part.content)
  }
}

async function readFile(attachments, ref, limit, signal) {
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > limit) throw new Error('附件为空或超过大小限制。')
  const chunks = []
  let length = 0
  for await (const chunk of attachments.readFileStream(ref, signal)) {
    signal?.throwIfAborted()
    length += chunk.byteLength
    if (length > limit) throw new Error('附件超过大小限制。')
    chunks.push(chunk)
  }
  if (length !== ref.bytes) throw new Error('附件内容不完整。')
  return Buffer.concat(chunks, length)
}

async function pdfText(file, extractor, signal) {
  const timeout = AbortSignal.timeout(10_000)
  const cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout
  const child = spawn(extractor, ['deepseek-pdf-text'], { stdio:['pipe', 'pipe', 'ignore'], signal:cancellation })
  const finished = new Promise(resolve => {
    child.once('error', () => resolve(false))
    child.once('close', code => resolve(code === 0))
  })
  child.stdin.on('error', () => {})
  child.stdin.end(file)
  const chunks = []
  let length = 0
  try {
    for await (const chunk of child.stdout) {
      length += chunk.length
      if (length > maxTextBytes) throw new Error('PDF 提取的文本超过本次附件限制。')
      chunks.push(chunk)
    }
    if (!await finished) throw new Error('PDF 无法提取文本。请检查它是否加密、损坏或只有扫描图像。')
    return Buffer.concat(chunks, length)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill() }
}

export async function prepareAttachments(ctx, config, messages, signal) {
  const documents = new Map()
  let textBytes = 0
  for (const message of messages) {
    for (const part of parts(message.content)) {
      if (part.type === 'image' && !config.imageInput) throw new Error('当前签约模型的渠道没有核验图片输入能力。')
      if (part.type !== 'file') continue
      const ref = part.attachment
      const extension = ref.name.split('.').at(-1)?.toLowerCase()
      if (extension !== 'pdf' && !textExtensions.has(extension)) continue
      const marker = ctx.llm.fileRequestText(ref)
      if (documents.has(marker)) continue
      if (documents.size >= 8) throw new Error('一个请求最多处理 8 个文档附件。')
      const file = await readFile(ctx.attachments, ref, extension === 'pdf' ? maxPDFBytes : maxTextBytes, signal)
      const data = extension === 'pdf' ? await pdfText(file, config.extractor, signal) : file
      const text = new TextDecoder('utf-8', { fatal:true }).decode(data).trim()
      if (!text || text.includes('\0')) throw new Error('附件没有可用的 UTF-8 文本。')
      textBytes += Buffer.byteLength(text)
      if (textBytes > maxPromptBytes) throw new Error('本次提示的附件文本超过大小限制。')
      documents.set(marker, { name:ref.name, marker, text })
    }
  }
  return [...documents.values()]
}
