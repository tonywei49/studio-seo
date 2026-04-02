import { useEffect, useMemo, useRef, useState } from 'react'

import { MatrixRain } from './MatrixRain'
import './App.css'
import type {
  BootstrapPayload,
  CompanyProfile,
  HistoryRecord,
  OutputLanguage,
  Product,
  ProductDraft,
  PromptTemplate,
  TdkRule,
  TitlePromptTemplate,
  TitleOption,
} from './types'

type ViewKey = 'settings' | 'output' | 'history'
type ThemeMode = 'normal' | 'brutal'
type ProcessKind = 'titles' | 'article' | 'translate' | 'batch'
type DocumentTaskKind = 'company' | 'product'
type RichTextBlock = {
  kind: 'heading' | 'paragraph'
  level: 1 | 2 | 3
  text: string
}
type NoticeState = {
  type: 'success' | 'error' | 'info'
  text: string
  variant?: 'default' | 'result'
  linkPath?: string
  linkLabel?: string
}
type OperationTimings = Record<string, number>

const PASSCODE = '魏裕弘真帅'

const emptyTitlePrompt = (): Omit<TitlePromptTemplate, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  direction: '',
  prompt: '',
})

const emptyPrompt = (): Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  direction: '',
  bodyPrompt: '',
  tdkPrompt: '',
  tdkRuleId: null,
  includeCompanyProfile: false,
})

const emptyRule = (): Omit<TdkRule, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  titleRule: '',
  descriptionRule: '',
  keywordsRule: '',
  mustInclude: [],
  forbiddenWords: [],
})

const emptyProduct = (): Omit<Product, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  content: '',
  keywords: [],
  scenarios: [],
  sourceName: '手动输入',
})

const processLabels: Record<ProcessKind, string[]> = {
  titles: ['加载规则', '拼接上下文', '生成候选标题', '同步输出面板'],
  article: ['锁定标题', '生成正文', '生成 TDK', '写入历史'],
  translate: ['读取原文', '翻译正文', '翻译 TDK', '同步历史'],
  batch: ['校验批量参数', '轮询生成标题', '批量落库导出', '刷新历史记录'],
}

const timingLabelMap: Record<string, string> = {
  bodyMs: '正文',
  tdkMs: 'TDK',
  translateMs: '翻译',
  translateBodyMs: '正文翻译',
  translateTdkMs: 'TDK翻译',
  dbMs: '写入',
  totalMs: '总计',
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function stripMarkdownHeading(value: string) {
  return value.replace(/^#{1,6}\s+/, '').trim()
}

function normalizeComparableText(value: string) {
  return stripMarkdownHeading(value)
    .replace(/\s+/g, ' ')
    .replace(/[：:;；。！？.!?]/g, '')
    .trim()
    .toLowerCase()
}

function detectHeadingLevel(block: string, index: number): 1 | 2 | 3 | null {
  const markdownMatch = block.match(/^(#{1,6})\s+(.+)$/)
  if (markdownMatch) {
    return Math.min(3, markdownMatch[1].length) as 1 | 2 | 3
  }

  const normalized = block.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.includes('\n') || normalized.length > 120) {
    return null
  }

  if (/^[-*]\s+/.test(normalized)) {
    return null
  }

  const hardSentencePunctuation = (normalized.match(/[。！？.!?]/g) ?? []).length
  const softSentencePunctuation = (normalized.match(/[；;]/g) ?? []).length
  const words = normalized.split(/\s+/).filter(Boolean)
  const hasHeadingPrefix = /^(第[一二三四五六七八九十0-9]+[章节部分篇]|[一二三四五六七八九十0-9]+[、.．)）])/.test(normalized)
  const looksLikeEnglishHeading =
    /[A-Za-z]/.test(normalized) && words.length <= 14 && hardSentencePunctuation === 0 && softSentencePunctuation <= 1
  const looksLikeShortHeading =
    normalized.length <= 34 && hardSentencePunctuation === 0 && softSentencePunctuation <= 1
  const endsWithColon = /[:：]$/.test(normalized)

  if (hasHeadingPrefix || looksLikeEnglishHeading || looksLikeShortHeading || endsWithColon) {
    return index === 0 ? 1 : normalized.length <= 18 ? 3 : 2
  }

  return null
}

function toOperationTimings(value: unknown): OperationTimings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const entries = Object.entries(value).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))
  if (!entries.length) {
    return null
  }

  return Object.fromEntries(entries) as OperationTimings
}

function formatTimingMs(value: number) {
  return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}s`
}

function formatTimingSummary(timings?: OperationTimings | null) {
  if (!timings) {
    return ''
  }

  const orderedKeys = ['bodyMs', 'tdkMs', 'translateMs', 'translateBodyMs', 'translateTdkMs', 'dbMs', 'totalMs']
  const parts = orderedKeys
    .filter((key) => typeof timings[key] === 'number')
    .map((key) => `${timingLabelMap[key] || key} ${formatTimingMs(timings[key])}`)

  return parts.join(' · ')
}

function readTimingSnapshot(meta: HistoryRecord['meta']) {
  const timings = toOperationTimings(meta.lastOperationTimings)
  if (!timings) {
    return null
  }

  const operation = typeof meta.lastOperation === 'string' ? meta.lastOperation : ''
  const operationLabel =
    operation === 'translate'
      ? '最近翻译耗时'
      : operation === 'tdk'
        ? '最近 TDK 耗时'
        : operation === 'body'
          ? '最近正文耗时'
          : '最近生成耗时'
  return {
    operationLabel,
    text: formatTimingSummary(timings),
  }
}

function toRichTextBlocks(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return [] as RichTextBlock[]
  }

  return normalized
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const level = detectHeadingLevel(block, index)
      return {
        kind: level ? 'heading' : 'paragraph',
        level: level ?? 2,
        text: stripMarkdownHeading(block),
      } satisfies RichTextBlock
    })
}

function formatInlineRichText(text: string) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br />')
}

function buildRichTextHtml(text: string, title?: string) {
  const blocks = toRichTextBlocks(text)
  const normalizedTitle = title?.trim() ? normalizeComparableText(title) : ''

  if (normalizedTitle) {
    if (blocks.length && normalizeComparableText(blocks[0].text) === normalizedTitle) {
      blocks[0] = { ...blocks[0], kind: 'heading', level: 1 }
    } else {
      blocks.unshift({ kind: 'heading', level: 1, text: title!.trim() })
    }
  }

  return blocks
    .map((block) => {
      const tag = block.kind === 'heading' ? `h${block.level}` : 'p'
      return `<${tag}>${formatInlineRichText(block.text)}</${tag}>`
    })
    .join('')
}

function buildPlainArticleText(text: string, title?: string) {
  const normalizedText = text.trim()
  const normalizedTitle = title?.trim()
  if (!normalizedTitle) {
    return normalizedText
  }
  if (!normalizedText) {
    return normalizedTitle
  }
  if (normalizeComparableText(normalizedText.split(/\n/)[0] ?? '') === normalizeComparableText(normalizedTitle)) {
    return normalizedText
  }
  return `${normalizedTitle}\n\n${normalizedText}`
}

function normalizeOutputLanguage(value: unknown): OutputLanguage {
  return value === 'en' ? 'en' : 'zh'
}

function App() {
  const [data, setData] = useState<BootstrapPayload | null>(null)
  const [activeView, setActiveView] = useState<ViewKey>('settings')
  const [themeMode, setThemeMode] = useState<ThemeMode>('normal')
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [processKind, setProcessKind] = useState<ProcessKind | null>(null)
  const [processIndex, setProcessIndex] = useState(0)
  const [settingsTesting, setSettingsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [copyToast, setCopyToast] = useState<string | null>(null)
  const [articleRefreshTarget, setArticleRefreshTarget] = useState<'initial' | 'body' | 'tdk' | 'translate' | null>(null)
  const [outputStatus, setOutputStatus] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const [settingsForm, setSettingsForm] = useState({
    apiUrl: '',
    apiKey: '',
    modelName: '',
    outputDir: '',
    productSplitMarker: '',
    titleTimeoutSec: 90,
    articleTimeoutSec: 35,
    englishTimeoutSec: 25,
  })
  const [companyForm, setCompanyForm] = useState<CompanyProfile>({
    sourceName: '',
    rawContent: '',
    strengths: [],
    tone: '',
    scenarios: [],
    updatedAt: '',
  })
  const [titlePromptForm, setTitlePromptForm] = useState<{ id?: number } & ReturnType<typeof emptyTitlePrompt>>(emptyTitlePrompt())
  const [promptForm, setPromptForm] = useState<{ id?: number } & ReturnType<typeof emptyPrompt>>(emptyPrompt())
  const [ruleForm, setRuleForm] = useState<{ id?: number } & ReturnType<typeof emptyRule>>(emptyRule())
  const [productForm, setProductForm] = useState<{ id?: number } & ReturnType<typeof emptyProduct>>(emptyProduct())
  const [isTitlePromptEditing, setIsTitlePromptEditing] = useState(false)
  const [isPromptEditing, setIsPromptEditing] = useState(false)
  const [isRuleEditing, setIsRuleEditing] = useState(false)
  const [documentTask, setDocumentTask] = useState<{
    kind: DocumentTaskKind
    steps: string[]
    index: number
  } | null>(null)

  const [direction, setDirection] = useState('')
  const [titlePromptId, setTitlePromptId] = useState<number | null>(null)
  const [articlePromptId, setArticlePromptId] = useState<number | null>(null)
  const [keyword, setKeyword] = useState('')
  const [productId, setProductId] = useState<number | null>(null)
  const [exportFormat, setExportFormat] = useState<'md' | 'docx'>('md')
  const [outputLanguage, setOutputLanguage] = useState<OutputLanguage>('zh')
  const [titles, setTitles] = useState<TitleOption[]>([])
  const [selectedTitle, setSelectedTitle] = useState<TitleOption | null>(null)
  const [latestRecord, setLatestRecord] = useState<HistoryRecord | null>(null)
  const [systemCode, setSystemCode] = useState('')
  const [batchCount, setBatchCount] = useState(5)
  const [batchDirections, setBatchDirections] = useState<string[]>([])
  const [batchProductIds, setBatchProductIds] = useState<number[]>([])
  const [batchResults, setBatchResults] = useState<HistoryRecord[]>([])
  const [pendingProductPreview, setPendingProductPreview] = useState<{
    items: ProductDraft[]
    processor: 'llm' | 'rule'
    processorMessage: string
    sourceName: string
    rawContent: string
    fallbackName: string
    splitMarker: string
  } | null>(null)
  const [historySearch, setHistorySearch] = useState('')
  const [historyDirectionFilter, setHistoryDirectionFilter] = useState('all')
  const [productPage, setProductPage] = useState(1)

  const companyUploadRef = useRef<HTMLInputElement | null>(null)
  const productUploadRef = useRef<HTMLInputElement | null>(null)
  const skipOutputResetRef = useRef(false)

  const directions = useMemo(() => {
    const names = new Set<string>()
    data?.titlePrompts.forEach((item) => names.add(item.direction))
    return Array.from(names)
  }, [data])

  const filteredTitlePrompts = useMemo(
    () => (data?.titlePrompts ?? []).filter((item) => item.direction === direction),
    [data, direction],
  )

  const filteredArticlePrompts = useMemo(
    () => (data?.prompts ?? []).filter((item) => item.direction === direction),
    [data, direction],
  )

  const historyDirections = useMemo(() => {
    const names = new Set<string>()
    data?.history.forEach((item) => names.add(item.direction))
    return Array.from(names)
  }, [data])

  const filteredHistory = useMemo(() => {
    const keyword = historySearch.trim().toLowerCase()
    return (data?.history ?? []).filter((item) => {
      const directionMatch = historyDirectionFilter === 'all' || item.direction === historyDirectionFilter
      const textMatch =
        !keyword ||
        item.selectedTitleZh.toLowerCase().includes(keyword) ||
        item.selectedTitleEn.toLowerCase().includes(keyword) ||
        item.direction.toLowerCase().includes(keyword)
      return directionMatch && textMatch
    })
  }, [data, historyDirectionFilter, historySearch])

  const productPageSize = 6
  const totalProductPages = Math.max(1, Math.ceil((data?.products.length ?? 0) / productPageSize))
  const pagedProducts = useMemo(() => {
    const list = data?.products ?? []
    const start = (productPage - 1) * productPageSize
    return list.slice(start, start + productPageSize)
  }, [data, productPage])

  useEffect(() => {
    void loadBootstrap()
  }, [])

  useEffect(() => {
    if (!data) {
      return
    }

    setSettingsForm({
      apiUrl: data.settings.apiUrl,
      apiKey: data.settings.apiKey,
      modelName: data.settings.modelName,
      outputDir: data.settings.outputDir,
      productSplitMarker: data.settings.productSplitMarker,
      titleTimeoutSec: data.settings.titleTimeoutSec,
      articleTimeoutSec: data.settings.articleTimeoutSec,
      englishTimeoutSec: data.settings.englishTimeoutSec,
    })
    setCompanyForm(data.company)

    if (!isTitlePromptEditing && !titlePromptForm.id && data.titlePrompts[0]) {
      setTitlePromptForm(data.titlePrompts[0])
      setIsTitlePromptEditing(false)
    }

    if (!isPromptEditing && !promptForm.id && data.prompts[0]) {
      setPromptForm(data.prompts[0])
      setIsPromptEditing(false)
    }

    if (!isRuleEditing && !ruleForm.id && data.rules[0]) {
      setRuleForm(data.rules[0])
      setIsRuleEditing(false)
    }

    if (!direction) {
      const nextDirection = data.titlePrompts[0]?.direction || data.prompts[0]?.direction || ''
      setDirection(nextDirection)
      setBatchDirections(nextDirection ? [nextDirection] : [])
    }
  }, [data, direction, isPromptEditing, isRuleEditing, isTitlePromptEditing, promptForm.id, ruleForm.id, titlePromptForm.id])

  useEffect(() => {
    const nextTitlePrompt = filteredTitlePrompts[0] ?? null
    if (!titlePromptId || !filteredTitlePrompts.some((item) => item.id === titlePromptId)) {
      setTitlePromptId(nextTitlePrompt?.id ?? null)
    }
    if (!articlePromptId || !filteredArticlePrompts.some((item) => item.id === articlePromptId)) {
      setArticlePromptId(filteredArticlePrompts[0]?.id ?? null)
    }
  }, [articlePromptId, filteredArticlePrompts, filteredTitlePrompts, titlePromptId])

  useEffect(() => {
    if (productPage > totalProductPages) {
      setProductPage(totalProductPages)
    }
  }, [productPage, totalProductPages])

  useEffect(() => {
    if (systemCode === PASSCODE) {
      setThemeMode('brutal')
      setNotice({ type: 'success', text: '暴力模式已解锁。界面已切换到红色矩阵。' })
    } else if (themeMode === 'brutal' && systemCode !== PASSCODE) {
      setThemeMode('normal')
    }
  }, [systemCode, themeMode])

  useEffect(() => {
    setTestResult(null)
  }, [settingsForm.apiUrl, settingsForm.apiKey, settingsForm.modelName])

  useEffect(() => {
    if (!processKind) {
      return
    }

    const timer = window.setInterval(() => {
      setProcessIndex((prev) => (prev + 1) % processLabels[processKind].length)
    }, 950)

    return () => window.clearInterval(timer)
  }, [processKind])

  useEffect(() => {
    if (!documentTask || documentTask.steps.length <= 1) {
      return
    }

    const timer = window.setInterval(() => {
      setDocumentTask((current) => {
        if (!current) {
          return current
        }
        if (current.index >= current.steps.length - 1) {
          return current
        }
        return { ...current, index: current.index + 1 }
      })
    }, 1150)

    return () => window.clearInterval(timer)
  }, [documentTask])

  useEffect(() => {
    if (!copyToast) {
      return
    }
    const timer = window.setTimeout(() => setCopyToast(null), 3000)
    return () => window.clearTimeout(timer)
  }, [copyToast])

  const currentProcessSteps = processKind ? processLabels[processKind] : []
  const companyProcessing = documentTask?.kind === 'company'
  const productProcessing = documentTask?.kind === 'product'

  useEffect(() => {
    if (skipOutputResetRef.current) {
      skipOutputResetRef.current = false
      return
    }
    setTitles([])
    setSelectedTitle(null)
    setLatestRecord(null)
    setBatchResults([])
    setOutputStatus(null)
  }, [direction, titlePromptId, keyword, productId])

  async function loadBootstrap() {
    try {
      setIsLoading(true)
      const payload = await requestJson<BootstrapPayload>('/api/bootstrap')
      setData(payload)
      setNotice({ type: 'info', text: '本地数据已加载。可以先在设置区检查模型配置。' })
    } catch (error) {
      setNotice({ type: 'error', text: getErrorMessage(error) })
    } finally {
      setIsLoading(false)
    }
  }

  async function withBusy<T>(kind: ProcessKind | null, job: () => Promise<T>) {
    try {
      setIsBusy(true)
      setProcessKind(kind)
      setProcessIndex(0)
      return await job()
    } finally {
      setIsBusy(false)
      setProcessKind(null)
    }
  }

  async function saveSettings() {
    const payload = await withBusy(null, () =>
      requestJson<BootstrapPayload>('/api/settings', {
        method: 'POST',
        body: JSON.stringify(settingsForm),
      }),
    )
    setData(payload)
    setNotice({ type: 'success', text: '模型设置已保存。' })
  }

  async function testLlmConnection() {
    setSettingsTesting(true)
    setTestResult(null)
    setNotice({ type: 'info', text: '正在测试 LLM 连接，请等待返回结果...' })
    try {
      const response = await withBusy(null, () =>
        requestJson<{ success: boolean; message: string }>('/api/settings/test-llm', {
          method: 'POST',
          body: JSON.stringify(settingsForm),
        }),
      )

      setNotice({
        type: 'success',
        text: `LLM 测试成功：${response.message}`,
      })
      setTestResult({
        type: 'success',
        text: `连接成功：${response.message}`,
      })
    } catch (error) {
      const message = getErrorMessage(error)
      setNotice({ type: 'error', text: `LLM 测试失败：${message}` })
      setTestResult({
        type: 'error',
        text: `连接失败：${message}`,
      })
    } finally {
      setSettingsTesting(false)
    }
  }

  async function selectOutputDirectory() {
    const response = await withBusy(null, () =>
      requestJson<{ cancelled: boolean; outputDir?: string }>('/api/system/select-output-dir', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )

    if (response.cancelled) {
      setNotice({ type: 'info', text: '已取消选择输出资料夹。' })
      return
    }

    if (response.outputDir) {
      setSettingsForm((prev) => ({ ...prev, outputDir: response.outputDir || prev.outputDir }))
      setNotice({ type: 'success', text: `已选择输出资料夹：${response.outputDir}` })
    }
  }

  async function saveCompany() {
    const response = await withBusy(null, () =>
      requestJson<{ company: CompanyProfile }>('/api/company/text', {
        method: 'POST',
        body: JSON.stringify(companyForm),
      }),
    )
    setData((current) => (current ? { ...current, company: response.company } : current))
    setCompanyForm(response.company)
    setNotice({ type: 'success', text: '公司资料已保存。' })
  }

  async function uploadCompany(file: File) {
    const form = new FormData()
    form.append('file', file)
    const useLlm = Boolean(settingsForm.apiUrl && settingsForm.apiKey && settingsForm.modelName)
    setDocumentTask({
      kind: 'company',
      steps: useLlm
        ? ['正在提取公司文档文本', '正在交给 LLM 整理公司资料', '正在回填公司资料表单']
        : ['正在提取公司文档文本', '未检测到可用 LLM，改用规则整理', '正在回填公司资料表单'],
      index: 0,
    })
    try {
      const response = await withBusy(null, () =>
        requestForm<{
          company: CompanyProfile
          processor: 'llm' | 'rule'
          processorMessage: string
        }>('/api/company/upload', form),
      )
      setData((current) => (current ? { ...current, company: response.company } : current))
      setCompanyForm(response.company)
      setNotice({
        type: response.processor === 'llm' ? 'success' : 'info',
        text: `公司资料已从 ${file.name} 导入。${response.processorMessage}`,
      })
    } finally {
      setDocumentTask(null)
    }
  }

  async function saveTitlePrompt() {
    if (!titlePromptForm.name || !titlePromptForm.direction || !titlePromptForm.prompt) {
      setNotice({ type: 'error', text: '请先完整填写标题 Prompt 名称、文案方向和标题 Prompt 内容。' })
      return
    }

    try {
      const response = await withBusy(null, () =>
        requestJson<{ titlePrompts: TitlePromptTemplate[]; prompts: PromptTemplate[]; savedId: number | null }>('/api/title-prompts', {
          method: 'POST',
          body: JSON.stringify(titlePromptForm),
        }),
      )
      const savedTitlePrompt =
        response.titlePrompts.find((item) => item.id === response.savedId) ?? response.titlePrompts[0] ?? emptyTitlePrompt()
      setData((current) =>
        current ? { ...current, titlePrompts: response.titlePrompts, prompts: response.prompts } : current,
      )
      setTitlePromptForm(savedTitlePrompt)
      setIsTitlePromptEditing(false)
      setNotice({ type: 'success', text: '标题 Prompt 已保存。' })
    } catch (error) {
      setNotice({ type: 'error', text: `标题 Prompt 保存失败：${getErrorMessage(error)}` })
    }
  }

  async function deleteTitlePrompt(id: number) {
    const response = await withBusy(null, () =>
      requestJson<{ titlePrompts: TitlePromptTemplate[]; prompts: PromptTemplate[] }>(`/api/title-prompts/${id}`, {
        method: 'DELETE',
      }),
    )
    setData((current) =>
      current ? { ...current, titlePrompts: response.titlePrompts, prompts: response.prompts } : current,
    )
    setTitlePromptForm(response.titlePrompts[0] ?? emptyTitlePrompt())
    setIsTitlePromptEditing(false)
    setNotice({ type: 'success', text: '标题 Prompt 已删除。' })
  }

  async function savePrompt() {
    if (!promptForm.name || !promptForm.direction || !promptForm.bodyPrompt || !promptForm.tdkPrompt) {
      setNotice({ type: 'error', text: '请先完整填写模板名、文案方向、正文 Prompt 和 TDK Prompt。' })
      return
    }

    try {
      const response = await withBusy(null, () =>
        requestJson<{ prompts: PromptTemplate[]; savedId: number | null }>('/api/prompts', {
          method: 'POST',
          body: JSON.stringify(promptForm),
        }),
      )
      const savedPrompt = response.prompts.find((item) => item.id === response.savedId) ?? response.prompts[0] ?? emptyPrompt()
      setData((current) => (current ? { ...current, prompts: response.prompts } : current))
      setPromptForm(savedPrompt)
      setIsPromptEditing(false)
      setNotice({ type: 'success', text: 'Prompt 模板已保存。' })
    } catch (error) {
      setNotice({ type: 'error', text: `Prompt 保存失败：${getErrorMessage(error)}` })
    }
  }

  async function deletePrompt(id: number) {
    const response = await withBusy(null, () =>
      requestJson<{ prompts: PromptTemplate[] }>(`/api/prompts/${id}`, { method: 'DELETE' }),
    )
    setData((current) => (current ? { ...current, prompts: response.prompts } : current))
    setPromptForm(response.prompts[0] ?? emptyPrompt())
    setIsPromptEditing(false)
    setNotice({ type: 'success', text: 'Prompt 模板已删除。' })
  }

  async function saveRule() {
    if (!ruleForm.name || !ruleForm.titleRule || !ruleForm.descriptionRule || !ruleForm.keywordsRule) {
      setNotice({ type: 'error', text: '请先完整填写规则名、Title 规则、Description 规则和 Keywords 规则。' })
      return
    }

    try {
      const response = await withBusy(null, () =>
        requestJson<{ rules: TdkRule[]; prompts: PromptTemplate[]; savedId: number | null }>('/api/rules', {
          method: 'POST',
          body: JSON.stringify(ruleForm),
        }),
      )
      const savedRule = response.rules.find((item) => item.id === response.savedId) ?? response.rules[0] ?? emptyRule()
      setData((current) => (current ? { ...current, rules: response.rules, prompts: response.prompts } : current))
      const syncedPrompt = promptForm.id ? response.prompts.find((item) => item.id === promptForm.id) : null
      if (syncedPrompt) {
        setPromptForm(syncedPrompt)
      }
      setRuleForm(savedRule)
      setIsRuleEditing(false)
      setNotice({ type: 'success', text: 'TDK 规则已保存。' })
    } catch (error) {
      setNotice({ type: 'error', text: `TDK 规则保存失败：${getErrorMessage(error)}` })
    }
  }

  async function deleteRule(id: number) {
    const response = await withBusy(null, () =>
      requestJson<{ rules: TdkRule[]; prompts: PromptTemplate[] }>(`/api/rules/${id}`, { method: 'DELETE' }),
    )
    setData((current) => (current ? { ...current, rules: response.rules, prompts: response.prompts } : current))
    const syncedPrompt = promptForm.id ? response.prompts.find((item) => item.id === promptForm.id) : null
    if (syncedPrompt) {
      setPromptForm(syncedPrompt)
    }
    setRuleForm(response.rules[0] ?? emptyRule())
    setIsRuleEditing(false)
    setNotice({ type: 'success', text: 'TDK 规则已删除。' })
  }

  async function saveProduct() {
    const response = await withBusy(null, () =>
      requestJson<{ products: Product[] }>('/api/products', {
        method: 'POST',
        body: JSON.stringify(productForm),
      }),
    )
    setData((current) => (current ? { ...current, products: response.products } : current))
    setProductForm(emptyProduct())
    setProductPage(1)
    setNotice({ type: 'success', text: '产品资料已保存。' })
  }

  async function deleteProduct(id: number) {
    const response = await withBusy(null, () =>
      requestJson<{ products: Product[] }>(`/api/products/${id}`, { method: 'DELETE' }),
    )
    setData((current) => (current ? { ...current, products: response.products } : current))
    setProductForm(emptyProduct())
    setProductPage(1)
    setNotice({ type: 'success', text: '产品资料已删除。' })
  }

  async function uploadProduct(file: File) {
    const form = new FormData()
    if (productForm.name) {
      form.append('name', productForm.name)
    }
    form.append('productSplitMarker', settingsForm.productSplitMarker)
    form.append('file', file)
    setDocumentTask({
      kind: 'product',
      steps: ['正在提取产品文档文本', '正在按分割标记切分产品', '正在写入产品预览区'],
      index: 0,
    })
    try {
      const response = await withBusy(null, () =>
        requestForm<{
          previewProducts: ProductDraft[]
          importCount: number
          processor: 'llm' | 'rule'
          processorMessage: string
          sourceName: string
          rawContent: string
          fallbackName: string
          splitMarker: string
        }>('/api/products/preview-upload', form),
      )
      setPendingProductPreview({
        items: response.previewProducts,
        processor: response.processor,
        processorMessage: response.processorMessage,
        sourceName: response.sourceName,
        rawContent: response.rawContent,
        fallbackName: response.fallbackName,
        splitMarker: response.splitMarker,
      })
      setNotice({
        type: 'info',
        text: `产品资料已从 ${file.name} 读取，预览出 ${response.importCount} 个产品候选。${response.processorMessage}`,
      })
    } finally {
      setDocumentTask(null)
    }
  }

  async function confirmProductPreview() {
    if (!pendingProductPreview?.items.length) {
      setNotice({ type: 'error', text: '没有可导入的产品候选。' })
      return
    }

    const response = await withBusy(null, () =>
      requestJson<{ products: Product[]; importCount: number }>('/api/products/confirm-import', {
        method: 'POST',
        body: JSON.stringify({ items: pendingProductPreview.items }),
      }),
    )

    setData((current) => (current ? { ...current, products: response.products } : current))
    setPendingProductPreview(null)
    setProductForm(emptyProduct())
    setProductPage(1)
    setNotice({ type: 'success', text: `已确认导入 ${response.importCount} 个产品。` })
  }

  async function resplitProductPreview() {
    if (!pendingProductPreview) {
      return
    }

    setDocumentTask({
      kind: 'product',
      steps: ['正在读取已上传文档', '正在按分割标记重新切分', '正在刷新产品预览区'],
      index: 0,
    })

    try {
      const response = await withBusy(null, () =>
        requestJson<{
          previewProducts: ProductDraft[]
          importCount: number
          processor: 'llm' | 'rule'
          processorMessage: string
          sourceName: string
          rawContent: string
          fallbackName: string
          splitMarker: string
        }>('/api/products/preview-text', {
          method: 'POST',
          body: JSON.stringify({
            rawContent: pendingProductPreview.rawContent,
            fallbackName: pendingProductPreview.fallbackName,
            sourceName: pendingProductPreview.sourceName,
            productSplitMarker: pendingProductPreview.splitMarker,
          }),
        }),
      )

      setPendingProductPreview({
        items: response.previewProducts,
        processor: response.processor,
        processorMessage: response.processorMessage,
        sourceName: response.sourceName,
        rawContent: response.rawContent,
        fallbackName: response.fallbackName,
        splitMarker: response.splitMarker,
      })
      setNotice({
        type: 'info',
        text: `已重新切分，当前共有 ${response.importCount} 个产品候选。${response.processorMessage}`,
      })
    } finally {
      setDocumentTask(null)
    }
  }

  function updatePreviewProduct(index: number, field: keyof ProductDraft, value: string | string[]) {
    setPendingProductPreview((current) => {
      if (!current) {
        return current
      }
      const nextItems = [...current.items]
      nextItems[index] = {
        ...nextItems[index],
        [field]: value,
      }
      return { ...current, items: nextItems }
    })
  }

  function removePreviewProduct(index: number) {
    setPendingProductPreview((current) => {
      if (!current) {
        return current
      }
      const items = current.items.filter((_, currentIndex) => currentIndex !== index)
      return { ...current, items }
    })
  }

  async function copyText(_label: string, text: string) {
    await navigator.clipboard.writeText(text)
    setCopyToast('已复制')
  }

  async function copyArticle(label: string, text: string, title: string) {
    const plainText = buildPlainArticleText(text, title)
    const html = `<div>${buildRichTextHtml(text, title)}</div>`

    try {
      if (navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([plainText], { type: 'text/plain' }),
          }),
        ])
        setCopyToast(`${label}已复制，可直接粘贴到编辑器`)
        return
      }
    } catch (error) {
      console.warn('富文本复制失败，回退为纯文本复制', error)
    }

    await navigator.clipboard.writeText(plainText)
    setCopyToast(`${label}已复制`)
  }

  async function generateTitleOptions() {
    setOutputStatus(null)
    setNotice({ type: 'info', text: '正在生成标题候选，请等待模型返回结果...' })
    try {
      const response = await withBusy('titles', () =>
        requestJson<{ titles: TitleOption[]; selectedTitlePromptId: number | null }>('/api/generate/titles', {
          method: 'POST',
          body: JSON.stringify({ direction, titlePromptId, keyword, productId }),
        }),
      )
      setTitles(response.titles)
      setSelectedTitle(response.titles[0] ?? null)
      setTitlePromptId(response.selectedTitlePromptId ?? titlePromptId)
      setArticlePromptId(filteredArticlePrompts[0]?.id ?? null)
      setLatestRecord(null)
      setBatchResults([])
      setNotice({ type: 'success', text: '已生成 4 组标题候选。' })
    } catch (error) {
      setTitles([])
      setSelectedTitle(null)
      setLatestRecord(null)
      setBatchResults([])
      setNotice({ type: 'error', text: `标题生成失败：${getErrorMessage(error)}` })
    }
  }

  async function refreshSingleTitle(index: number) {
    setNotice({ type: 'info', text: '正在刷新单个标题，请等待模型返回结果...' })
    try {
      const response = await withBusy('titles', () =>
        requestJson<{ titles: TitleOption[]; selectedTitlePromptId: number | null }>('/api/generate/titles', {
          method: 'POST',
          body: JSON.stringify({ direction, titlePromptId, keyword, productId }),
        }),
      )
      const replacement = response.titles[0]
      if (!replacement) {
        return
      }
      setTitles((current) => {
        const next = [...current]
        next[index] = replacement
        return next
      })
      if (selectedTitle && titles[index]?.zh === selectedTitle.zh) {
        setSelectedTitle(replacement)
      }
      setNotice({ type: 'info', text: '单个标题已刷新。' })
    } catch (error) {
      setNotice({ type: 'error', text: `标题刷新失败：${getErrorMessage(error)}` })
    }
  }

  async function generateArticle(options?: { refreshTarget?: 'initial' | 'body' | 'tdk'; preserveNotice?: boolean }) {
    const effectiveSelectedTitle =
      selectedTitle ?? (latestRecord ? { zh: latestRecord.selectedTitleZh, en: latestRecord.selectedTitleEn } : null)
    const effectivePromptTemplateId = articlePromptId ?? latestRecord?.promptTemplateId ?? null

    if (!effectiveSelectedTitle) {
      if (options?.preserveNotice) {
        setOutputStatus({ type: 'error', text: '请先选择标题。' })
      } else {
        setNotice({ type: 'error', text: '请先选择标题。' })
      }
      return
    }
    if (!effectivePromptTemplateId) {
      if (options?.preserveNotice) {
        setOutputStatus({ type: 'error', text: '请先选择文章生成 Prompt。' })
      } else {
        setNotice({ type: 'error', text: '请先选择文章生成 Prompt。' })
      }
      return
    }

    setOutputStatus(null)
    setArticleRefreshTarget(options?.refreshTarget ?? 'initial')
    let createdRecord: HistoryRecord | null = null
    try {
      const response = await withBusy('article', () =>
        requestJson<{
          record: HistoryRecord | null
          records: HistoryRecord[]
          history: HistoryRecord[]
          processor?: 'llm' | 'rule'
          processorMessage?: string
          timings?: OperationTimings
        }>('/api/generate/article', {
          method: 'POST',
          body: JSON.stringify({
            direction,
            promptTemplateId: effectivePromptTemplateId,
            keyword,
            outputLanguage,
            productId,
            mode: themeMode === 'brutal' ? 'brutal' : 'standard',
            titles,
            selectedTitle: { zh: effectiveSelectedTitle.zh, en: effectiveSelectedTitle.en },
            quantity: 1,
          }),
        }),
      )

      createdRecord = response.record
      if (response.record) {
        applyOutputRecord(response.record, response.history)
      }
      setBatchResults(response.records.length > 1 ? response.records : [])
      setActiveView('output')
      const timingSummary = formatTimingSummary(response.timings)
      setOutputStatus({
        type: 'info',
        text: `${response.processorMessage ? `${response.processorMessage} ` : ''}正文已生成，正在生成 TDK。${
          timingSummary ? ` ${timingSummary}` : ''
        }`,
      })
      if (!options?.preserveNotice) {
        setNotice({
          type: response.processor === 'rule' ? 'info' : 'success',
          text: `${response.processorMessage ? `${response.processorMessage} ` : ''}正文已生成，TDK 将继续补全。${
            timingSummary ? ` ${timingSummary}` : ''
          }`,
        })
      }
    } catch (error) {
      if (options?.preserveNotice) {
        setOutputStatus({ type: 'error', text: getErrorMessage(error) })
      } else {
        setNotice({ type: 'error', text: getErrorMessage(error) })
      }
    } finally {
      setArticleRefreshTarget(null)
    }

    if (createdRecord) {
      await generateTdkForRecord(createdRecord.id, { afterBody: true })
    }
  }

  async function regenerateLatestRecord(target: 'body' | 'tdk') {
    if (!latestRecord) {
      setOutputStatus({ type: 'error', text: '当前没有可重新生成的内容。' })
      return
    }

    setOutputStatus(null)
    if (target === 'tdk') {
      await generateTdkForRecord(latestRecord.id)
      return
    }

    setArticleRefreshTarget('body')
    let refreshedRecord: HistoryRecord | null = null
    try {
      const response = await withBusy('article', () =>
        requestJson<{ record: HistoryRecord; history: HistoryRecord[]; timings?: OperationTimings }>(
          `/api/history/${latestRecord.id}/regenerate`,
          {
            method: 'POST',
            body: JSON.stringify({ target: 'body' }),
          },
        ),
      )
      refreshedRecord = response.record
      applyOutputRecord(response.record, response.history)
      setOutputStatus({
        type: 'info',
        text: `正文已重新生成，正在生成 TDK。${response.timings ? ` ${formatTimingSummary(response.timings)}` : ''}`,
      })
    } catch (error) {
      setOutputStatus({ type: 'error', text: getErrorMessage(error) })
    } finally {
      setArticleRefreshTarget(null)
    }

    if (refreshedRecord) {
      await generateTdkForRecord(refreshedRecord.id, { afterBody: true })
    }
  }

  async function translateLatestRecord(targetLanguage: OutputLanguage) {
    if (!latestRecord) {
      setOutputStatus({ type: 'error', text: '当前没有可翻译的内容。' })
      return
    }

    setOutputStatus(null)
    setArticleRefreshTarget('translate')
    try {
      const response = await withBusy('translate', () =>
        requestJson<{ record: HistoryRecord; history: HistoryRecord[]; timings?: OperationTimings }>(
          `/api/history/${latestRecord.id}/translate`,
          {
            method: 'POST',
            body: JSON.stringify({ targetLanguage }),
          },
        ),
      )
      setLatestRecord(response.record)
      setData((current) => (current ? { ...current, history: response.history } : current))
      setOutputStatus({
        type: 'success',
        text: `${targetLanguage === 'zh' ? '中文翻译已生成。' : '英文翻译已生成。'}${
          response.timings ? ` ${formatTimingSummary(response.timings)}` : ''
        }`,
      })
    } catch (error) {
      setOutputStatus({ type: 'error', text: getErrorMessage(error) })
    } finally {
      setArticleRefreshTarget(null)
    }
  }

  async function runBatch() {
    if (!batchDirections.length) {
      setNotice({ type: 'error', text: '请先选择至少一个文案方向。' })
      return
    }

    const response = await withBusy('batch', () =>
      requestJson<{ records: HistoryRecord[]; history: HistoryRecord[] }>('/api/generate/batch', {
        method: 'POST',
        body: JSON.stringify({
          quantity: batchCount,
          directionPool: batchDirections,
          productIds: batchProductIds,
          outputLanguage,
          exportFormat,
        }),
      }),
    )

    setBatchResults(response.records)
    setLatestRecord(response.records[0] ?? null)
    setData((current) => (current ? { ...current, history: response.history } : current))
    setActiveView('output')
    setNotice({ type: 'success', text: `批量生成完成，共输出 ${response.records.length} 篇。` })
  }

  async function exportRecord(recordId: number, format: 'md' | 'docx') {
    const response = await withBusy(null, () =>
      requestJson<{ record: HistoryRecord; history: HistoryRecord[]; savedPath: string }>(
        `/api/history/${recordId}/export`,
        {
          method: 'POST',
          body: JSON.stringify({ format }),
        },
      ),
    )
    setData((current) => (current ? { ...current, history: response.history } : current))
    if (latestRecord?.id === recordId) {
      setLatestRecord(response.record)
    }
    setNotice({
      type: 'success',
      variant: 'result',
      text: '已保存到本地。',
      linkPath: response.savedPath,
      linkLabel: fileNameFromPath(response.savedPath),
    })
  }

  async function openNoticePath(targetPath: string) {
    await withBusy(null, () =>
      requestJson<{ success: boolean }>('/api/system/open-path', {
        method: 'POST',
        body: JSON.stringify({ path: targetPath }),
      }),
    )
  }

  function clearOutputStage() {
    setTitles([])
    setSelectedTitle(null)
    setLatestRecord(null)
    setBatchResults([])
    setOutputStatus(null)
    setArticleRefreshTarget(null)
  }

  function applyOutputRecord(record: HistoryRecord, history: HistoryRecord[]) {
    setLatestRecord(record)
    setData((current) => (current ? { ...current, history } : current))
    setTitles(record.titleOptions)
    setSelectedTitle(
      record.titleOptions.find(
        (item) => item.zh === record.selectedTitleZh && item.en === record.selectedTitleEn,
      ) ?? {
        zh: record.selectedTitleZh,
        en: record.selectedTitleEn,
        reason: '输出结果',
      },
    )
    setArticlePromptId(record.promptTemplateId)
  }

  async function generateTdkForRecord(recordId: number, options?: { afterBody?: boolean }) {
    setArticleRefreshTarget('tdk')
    try {
      const response = await withBusy('article', () =>
        requestJson<{ record: HistoryRecord; history: HistoryRecord[]; timings?: OperationTimings }>(
          `/api/history/${recordId}/regenerate`,
          {
            method: 'POST',
            body: JSON.stringify({ target: 'tdk' }),
          },
        ),
      )
      applyOutputRecord(response.record, response.history)
      setOutputStatus({
        type: 'success',
        text: `${
          options?.afterBody ? 'TDK 已补全。' : 'TDK 已重新生成。'
        }${response.timings ? ` ${formatTimingSummary(response.timings)}` : ''}`,
      })
      return response.record
    } catch (error) {
      setOutputStatus({ type: 'error', text: `TDK 生成失败：${getErrorMessage(error)}` })
      return null
    } finally {
      setArticleRefreshTarget(null)
    }
  }

  function loadHistoryRecord(record: HistoryRecord) {
    const matchedTitle =
      record.titleOptions.find(
        (item) => item.zh === record.selectedTitleZh && item.en === record.selectedTitleEn,
      ) ?? {
        zh: record.selectedTitleZh,
        en: record.selectedTitleEn,
        reason: '历史记录回填',
      }
    skipOutputResetRef.current = true
    setDirection(record.direction)
    setProductId(record.productId)
    setOutputLanguage(normalizeOutputLanguage(record.meta.outputLanguage))
    setTitles(record.titleOptions)
    setSelectedTitle(matchedTitle)
    setArticlePromptId(record.promptTemplateId)
    setLatestRecord(record)
    setOutputStatus(null)
    setActiveView('output')
  }

  const viewContent = {
    settings: renderSettings(),
    output: renderOutput(),
    history: renderHistory(),
  }[activeView]

  return (
    <div className="app-shell" data-mode={themeMode}>
      <MatrixRain mode={themeMode} />
      {copyToast ? <div className="copy-toast">{copyToast}</div> : null}
      <div className="app-inner">
        <header className="hero-bar">
          <div>
            <p className="eyebrow">LOCAL SEO MATRIX STUDIO</p>
            <h1>SEO 文案矩阵控制台</h1>
            <p className="hero-copy">
              本地网页工具，使用单一公司资料、产品库、 Prompt 与 TDK 规则，生成中英标题，以及单语正文与 TDK，再按需补翻译。
            </p>
          </div>
          <div className="hero-stats">
            <div className="stat-card">
              <span>Prompt</span>
              <strong>{data?.prompts.length ?? 0}</strong>
            </div>
            <div className="stat-card">
              <span>Products</span>
              <strong>{data?.products.length ?? 0}</strong>
            </div>
            <div className="stat-card">
              <span>History</span>
              <strong>{data?.history.length ?? 0}</strong>
            </div>
          </div>
        </header>

        <nav className="view-tabs">
          {[
            ['settings', '设置区'],
            ['output', '输出区'],
            ['history', '历史记录'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={activeView === value ? 'active' : ''}
              onClick={() => setActiveView(value as ViewKey)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className={`notice ${notice?.type ?? 'info'} ${notice?.variant === 'result' ? 'result' : ''}`}>
          <div className="notice-main">
            <span>{isLoading ? '正在加载本地数据...' : notice?.text ?? '等待操作。'}</span>
            {!isLoading && notice?.linkPath ? (
              <button
                type="button"
                className="notice-link"
                onClick={() => void openNoticePath(notice.linkPath!)}
              >
                {notice.linkLabel || fileNameFromPath(notice.linkPath)}
              </button>
            ) : null}
          </div>
          <span>{themeMode === 'brutal' ? 'BRUTAL MODE' : 'GREEN MODE'}</span>
        </div>

        {processKind ? (
          <section className="process-strip">
            {currentProcessSteps.map((item, index) => (
              <div
                key={item}
                className={[
                  'process-step',
                  index < processIndex ? 'done' : '',
                  index === processIndex ? 'active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{item}</strong>
              </div>
            ))}
          </section>
        ) : null}

        {viewContent}
      </div>
    </div>
  )

  function renderSettings() {
    return (
      <main className="content-grid settings-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">MODEL CORE</p>
              <h2>模型与输出目录</h2>
            </div>
            <a href={data?.nodeDownloadUrl || 'https://nodejs.org/en/download'} target="_blank" rel="noreferrer">
              Node.js 官方下载
            </a>
          </div>
          {settingsTesting ? (
            <div className="processing-banner">
              <span className="processing-dot" />
              <span>正在向当前模型地址发送测试请求，最多等待 15 秒。</span>
              <strong className="processing-step">TEST</strong>
            </div>
          ) : null}
          {testResult ? (
            <div className={`test-result ${testResult.type}`}>
              <strong>{testResult.type === 'success' ? '测试成功' : '测试失败'}</strong>
              <span>{testResult.text}</span>
            </div>
          ) : null}
          <div className="form-grid">
            <label>
              <span>API URL</span>
              <input
                value={settingsForm.apiUrl}
                onChange={(event) => setSettingsForm((prev) => ({ ...prev, apiUrl: event.target.value }))}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label>
              <span>Model Name</span>
              <input
                value={settingsForm.modelName}
                onChange={(event) => setSettingsForm((prev) => ({ ...prev, modelName: event.target.value }))}
                placeholder="gpt-4.1-mini / custom-model"
              />
            </label>
            <label className="full">
              <span>API Key</span>
              <input
                type="password"
                value={settingsForm.apiKey}
                onChange={(event) => setSettingsForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                placeholder="输入后会掩码显示"
              />
            </label>
            <label className="full">
              <span>输出保存资料夹</span>
              <div className="path-picker">
                <input
                  value={settingsForm.outputDir}
                  readOnly
                  placeholder="请选择输出资料夹"
                />
                <button type="button" className="ghost" onClick={() => void selectOutputDirectory()} disabled={isBusy}>
                  选择资料夹
                </button>
              </div>
            </label>
            <label>
              <span>标题超时（秒）</span>
              <input
                type="number"
                min={5}
                max={300}
                value={settingsForm.titleTimeoutSec}
                onChange={(event) =>
                  setSettingsForm((prev) => ({
                    ...prev,
                    titleTimeoutSec: Math.max(5, Math.min(300, Number(event.target.value) || 5)),
                  }))
                }
              />
            </label>
            <label>
              <span>正文超时（秒）</span>
              <input
                type="number"
                min={5}
                max={300}
                value={settingsForm.articleTimeoutSec}
                onChange={(event) =>
                  setSettingsForm((prev) => ({
                    ...prev,
                    articleTimeoutSec: Math.max(5, Math.min(300, Number(event.target.value) || 5)),
                  }))
                }
              />
            </label>
            <label>
              <span>英文超时（秒）</span>
              <input
                type="number"
                min={5}
                max={300}
                value={settingsForm.englishTimeoutSec}
                onChange={(event) =>
                  setSettingsForm((prev) => ({
                    ...prev,
                    englishTimeoutSec: Math.max(5, Math.min(300, Number(event.target.value) || 5)),
                  }))
                }
              />
            </label>
            <div className="readonly-banner subtle full">
              <span>超过设定秒数会直接报超时，不再自动改用规则生成正文或 TDK。</span>
            </div>
          </div>
          <div className="panel-actions">
            <button type="button" className="ghost" onClick={() => void testLlmConnection()} disabled={isBusy || settingsTesting}>
              测试连接
            </button>
            <button type="button" onClick={() => void saveSettings()} disabled={isBusy}>
              保存模型设置
            </button>
          </div>
        </section>

        <section className={`panel ${companyProcessing ? 'panel-processing' : ''}`}>
          <div className="panel-head">
            <div>
              <p className="panel-kicker">COMPANY DNA</p>
              <h2>公司资料</h2>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => companyUploadRef.current?.click()}
              disabled={isBusy || companyProcessing}
            >
              上传文档
            </button>
          </div>
          {companyProcessing ? (
            <div className="processing-banner">
              <span className="processing-dot" />
              <span>{documentTask?.steps[documentTask.index] ?? ''}</span>
              <strong className="processing-step">
                {documentTask ? `${documentTask.index + 1}/${documentTask.steps.length}` : ''}
              </strong>
            </div>
          ) : null}
          <input
            ref={companyUploadRef}
            type="file"
            hidden
            accept=".docx,.pdf,.txt,.md"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                void uploadCompany(file)
              }
              event.currentTarget.value = ''
            }}
          />
          <div className="form-grid">
            <label>
              <span>来源说明</span>
              <input
                value={companyForm.sourceName}
                onChange={(event) => setCompanyForm((prev) => ({ ...prev, sourceName: event.target.value }))}
                readOnly={companyProcessing}
              />
            </label>
            <label>
              <span>品牌语气</span>
              <input
                value={companyForm.tone}
                onChange={(event) => setCompanyForm((prev) => ({ ...prev, tone: event.target.value }))}
                readOnly={companyProcessing}
              />
            </label>
            <label className="full">
              <span>公司优势</span>
              <textarea
                rows={4}
                value={companyForm.strengths.join('\n')}
                onChange={(event) =>
                  setCompanyForm((prev) => ({ ...prev, strengths: linesToList(event.target.value) }))
                }
                readOnly={companyProcessing}
              />
            </label>
            <label className="full">
              <span>适用场景</span>
              <textarea
                rows={3}
                value={companyForm.scenarios.join('\n')}
                onChange={(event) =>
                  setCompanyForm((prev) => ({ ...prev, scenarios: linesToList(event.target.value) }))
                }
                readOnly={companyProcessing}
              />
            </label>
            <label className="full">
              <span>原始公司资料</span>
              <textarea
                rows={8}
                value={companyForm.rawContent}
                onChange={(event) => setCompanyForm((prev) => ({ ...prev, rawContent: event.target.value }))}
                readOnly={companyProcessing}
              />
            </label>
          </div>
          <div className="panel-actions">
            <button type="button" onClick={() => void saveCompany()} disabled={isBusy || companyProcessing}>
              保存公司资料
            </button>
          </div>
        </section>

        <section className="panel double">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">TITLE PROMPTS</p>
              <h2>标题 Prompt</h2>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setTitlePromptForm(emptyTitlePrompt())
                setIsTitlePromptEditing(true)
              }}
            >
              新建标题 Prompt
            </button>
          </div>
          <div className="split-grid">
            <div className="stack-list compact-list">
              {data?.titlePrompts.map((item) => (
                <article
                  key={item.id}
                  className={`mini-card selectable ${titlePromptForm.id === item.id ? 'active' : ''}`}
                  onClick={() => {
                    setTitlePromptForm(item)
                    setIsTitlePromptEditing(false)
                  }}
                >
                  <div>
                    <strong>{item.name}</strong>
                  </div>
                  <div className="mini-actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={(event) => {
                        event.stopPropagation()
                        setTitlePromptForm(item)
                        setIsTitlePromptEditing(true)
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ghost danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        void deleteTitlePrompt(item.id)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="form-grid">
              <div className="readonly-banner full">
                <span>{isTitlePromptEditing ? (titlePromptForm.id ? '编辑模式' : '新建模式') : '预览模式'}</span>
                <div className="mini-actions">
                  {titlePromptForm.id ? (
                    <button type="button" className="ghost" onClick={() => setIsTitlePromptEditing((prev) => !prev)}>
                      {isTitlePromptEditing ? '切回只读' : '编辑当前标题 Prompt'}
                    </button>
                  ) : null}
                </div>
              </div>
              <label>
                <span>标题 Prompt 名称</span>
                <input
                  value={titlePromptForm.name}
                  onChange={(event) => setTitlePromptForm((prev) => ({ ...prev, name: event.target.value }))}
                  readOnly={!isTitlePromptEditing}
                />
              </label>
              <label>
                <span>文案方向</span>
                <input
                  value={titlePromptForm.direction}
                  onChange={(event) => setTitlePromptForm((prev) => ({ ...prev, direction: event.target.value }))}
                  readOnly={!isTitlePromptEditing}
                />
              </label>
              <label className="full">
                <span>标题 Prompt</span>
                <textarea
                  rows={5}
                  value={titlePromptForm.prompt}
                  onChange={(event) => setTitlePromptForm((prev) => ({ ...prev, prompt: event.target.value }))}
                  readOnly={!isTitlePromptEditing}
                />
              </label>
              {isTitlePromptEditing ? (
                <div className="panel-actions full">
                  <button type="button" onClick={() => void saveTitlePrompt()} disabled={isBusy}>
                    保存标题 Prompt
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="panel double">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">PROMPT BANK</p>
              <h2>文章生成 Prompt</h2>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setPromptForm(emptyPrompt())
                setIsPromptEditing(true)
              }}
            >
              新建模板
            </button>
          </div>
          <div className="split-grid">
            <div className="stack-list compact-list">
              {data?.prompts.map((item) => (
                <article
                  key={item.id}
                  className={`mini-card selectable ${promptForm.id === item.id ? 'active' : ''}`}
                  onClick={() => {
                    setPromptForm(item)
                    setIsPromptEditing(false)
                  }}
                >
                  <div>
                    <strong>{item.name}</strong>
                  </div>
                  <div className="mini-actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={(event) => {
                        event.stopPropagation()
                        setPromptForm(item)
                        setIsPromptEditing(true)
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ghost danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        void deletePrompt(item.id)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="form-grid">
              <div className="readonly-banner full">
                <span>{isPromptEditing ? (promptForm.id ? '编辑模式' : '新建模式') : '预览模式'}</span>
                <div className="mini-actions">
                  {promptForm.id ? (
                    <button type="button" className="ghost" onClick={() => setIsPromptEditing((prev) => !prev)}>
                      {isPromptEditing ? '切回只读' : '编辑当前方案'}
                    </button>
                  ) : null}
                </div>
              </div>
              <label>
                <span>模板名</span>
                <input
                  value={promptForm.name}
                  onChange={(event) => setPromptForm((prev) => ({ ...prev, name: event.target.value }))}
                  readOnly={!isPromptEditing}
                />
              </label>
              <label>
                <span>文案方向</span>
                <select
                  value={promptForm.direction}
                  onChange={(event) =>
                    setPromptForm((prev) => {
                      const nextDirection = event.target.value
                      const hasMatchedRule = (data?.rules ?? []).some(
                        (item) => item.id === prev.tdkRuleId,
                      )
                      return {
                        ...prev,
                        direction: nextDirection,
                        tdkRuleId: hasMatchedRule ? prev.tdkRuleId : null,
                      }
                    })
                  }
                  disabled={!isPromptEditing}
                >
                  <option value="">请选择文案方向</option>
                  {Array.from(new Set((data?.titlePrompts ?? []).map((item) => item.direction))).map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="full">
                <span>正文 Prompt</span>
                <textarea
                  rows={5}
                  value={promptForm.bodyPrompt}
                  onChange={(event) => setPromptForm((prev) => ({ ...prev, bodyPrompt: event.target.value }))}
                  readOnly={!isPromptEditing}
                />
              </label>
              <label className="checkbox-row full">
                <input
                  type="checkbox"
                  checked={promptForm.includeCompanyProfile}
                  onChange={(event) =>
                    setPromptForm((prev) => ({ ...prev, includeCompanyProfile: event.target.checked }))
                  }
                  disabled={!isPromptEditing}
                />
                <span>
                  勾选后自动在正文 Prompt 末尾追加公司优势引导，并带入原始公司资料。
                </span>
              </label>
              <label className="full">
                <span>TDK Prompt</span>
                <textarea
                  rows={4}
                  value={promptForm.tdkPrompt}
                  onChange={(event) => setPromptForm((prev) => ({ ...prev, tdkPrompt: event.target.value }))}
                  readOnly={!isPromptEditing}
                />
              </label>
              <label>
                <span>绑定 TDK 规则</span>
                <select
                  value={promptForm.tdkRuleId ?? ''}
                  onChange={(event) =>
                    setPromptForm((prev) => ({
                      ...prev,
                      tdkRuleId: event.target.value ? Number(event.target.value) : null,
                    }))
                  }
                  disabled={!isPromptEditing}
                >
                  <option value="">---</option>
                  {(data?.rules ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {isPromptEditing ? (
                <div className="panel-actions full">
                  <button type="button" onClick={() => void savePrompt()} disabled={isBusy}>
                    保存 Prompt
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="panel double">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">RULE ENGINE</p>
              <h2>TDK 规则</h2>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setRuleForm(emptyRule())
                setIsRuleEditing(true)
              }}
            >
              新建规则
            </button>
          </div>
          <div className="split-grid">
            <div className="stack-list compact-list">
              {data?.rules.map((item) => (
                <article
                  key={item.id}
                  className={`mini-card selectable ${ruleForm.id === item.id ? 'active' : ''}`}
                  onClick={() => {
                    setRuleForm(item)
                    setIsRuleEditing(false)
                  }}
                >
                  <div>
                    <strong>{item.name}</strong>
                  </div>
                  <div className="mini-actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={(event) => {
                        event.stopPropagation()
                        setRuleForm(item)
                        setIsRuleEditing(true)
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ghost danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        void deleteRule(item.id)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="form-grid">
              <div className="readonly-banner full">
                <span>{isRuleEditing ? (ruleForm.id ? '编辑模式' : '新建模式') : '预览模式'}</span>
                <div className="mini-actions">
                  {ruleForm.id ? (
                    <button type="button" className="ghost" onClick={() => setIsRuleEditing((prev) => !prev)}>
                      {isRuleEditing ? '切回只读' : '编辑当前规则'}
                    </button>
                  ) : null}
                </div>
              </div>
              <label>
                <span>规则名</span>
                <input
                  value={ruleForm.name}
                  onChange={(event) => setRuleForm((prev) => ({ ...prev, name: event.target.value }))}
                  readOnly={!isRuleEditing}
                />
              </label>
              <label>
                <span>Title 规则</span>
                <textarea
                  rows={3}
                  value={ruleForm.titleRule}
                  onChange={(event) => setRuleForm((prev) => ({ ...prev, titleRule: event.target.value }))}
                  readOnly={!isRuleEditing}
                />
              </label>
              <label className="full">
                <span>Description 规则</span>
                <textarea
                  rows={3}
                  value={ruleForm.descriptionRule}
                  onChange={(event) =>
                    setRuleForm((prev) => ({ ...prev, descriptionRule: event.target.value }))
                  }
                  readOnly={!isRuleEditing}
                />
              </label>
              <label className="full">
                <span>Keywords 规则</span>
                <textarea
                  rows={3}
                  value={ruleForm.keywordsRule}
                  onChange={(event) => setRuleForm((prev) => ({ ...prev, keywordsRule: event.target.value }))}
                  readOnly={!isRuleEditing}
                />
              </label>
              <label>
                <span>必带词</span>
                <textarea
                  rows={3}
                  value={ruleForm.mustInclude.join('\n')}
                  onChange={(event) =>
                    setRuleForm((prev) => ({ ...prev, mustInclude: linesToList(event.target.value) }))
                  }
                  readOnly={!isRuleEditing}
                />
              </label>
              <label>
                <span>禁用词</span>
                <textarea
                  rows={3}
                  value={ruleForm.forbiddenWords.join('\n')}
                  onChange={(event) =>
                    setRuleForm((prev) => ({ ...prev, forbiddenWords: linesToList(event.target.value) }))
                  }
                  readOnly={!isRuleEditing}
                />
              </label>
              {isRuleEditing ? (
                <div className="panel-actions full">
                  <button type="button" onClick={() => void saveRule()} disabled={isBusy}>
                    保存规则
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className={`panel double ${productProcessing ? 'panel-processing' : ''}`}>
          <div className="panel-head">
            <div>
              <p className="panel-kicker">PRODUCT BANK</p>
              <h2>产品资料</h2>
            </div>
            <div className="mini-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setProductForm(emptyProduct())}
                disabled={isBusy || productProcessing}
              >
                新建产品
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => productUploadRef.current?.click()}
                disabled={isBusy || productProcessing}
              >
                上传产品文档
              </button>
            </div>
          </div>
          {productProcessing ? (
            <div className="processing-banner">
              <span className="processing-dot" />
              <span>{documentTask?.steps[documentTask.index] ?? ''}</span>
              <strong className="processing-step">
                {documentTask ? `${documentTask.index + 1}/${documentTask.steps.length}` : ''}
              </strong>
            </div>
          ) : null}
          <input
            ref={productUploadRef}
            type="file"
            hidden
            accept=".docx,.pdf,.txt,.md"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                void uploadProduct(file)
              }
              event.currentTarget.value = ''
            }}
          />
          <div className="split-grid">
            <div className="stack-list product-stack compact-list">
              {pagedProducts.map((item) => (
                <article key={item.id} className="mini-card product-item">
                  <div className="product-item-copy">
                    <strong title={item.name}>{item.name}</strong>
                    <p title={item.sourceName}>{item.sourceName}</p>
                  </div>
                  <div className="mini-actions product-item-actions">
                    <button type="button" className="ghost" onClick={() => setProductForm(item)}>
                      编辑
                    </button>
                    <button type="button" className="ghost danger" onClick={() => void deleteProduct(item.id)}>
                      删除
                    </button>
                  </div>
                </article>
              ))}
              <div className="list-pagination">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setProductPage((current) => Math.max(1, current - 1))}
                  disabled={productPage <= 1}
                >
                  上一页
                </button>
                <span>
                  {productPage} / {totalProductPages}
                </span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setProductPage((current) => Math.min(totalProductPages, current + 1))}
                  disabled={productPage >= totalProductPages}
                >
                  下一页
                </button>
              </div>
            </div>
            <div className="form-grid product-form-grid">
              {pendingProductPreview ? (
                <section className="preview-panel full">
                  <div className="panel-head compact">
                    <div>
                      <p className="panel-kicker">IMPORT PREVIEW</p>
                      <h3>产品拆分确认</h3>
                    </div>
                    <div className="mini-actions">
                      <button type="button" className="ghost" onClick={() => setPendingProductPreview(null)} disabled={isBusy}>
                        取消
                      </button>
                      <button type="button" onClick={() => void confirmProductPreview()} disabled={isBusy || !pendingProductPreview.items.length}>
                        确认导入
                      </button>
                    </div>
                  </div>
                  <div className="readonly-banner subtle">
                    <span>
                      来源：{pendingProductPreview.sourceName}，共 {pendingProductPreview.items.length} 个候选。{pendingProductPreview.processorMessage}
                    </span>
                  </div>
                  <div className="form-grid preview-form-grid split-marker-box">
                    <label className="full">
                      <span>产品分割标记</span>
                      <input
                        value={pendingProductPreview.splitMarker}
                        onChange={(event) =>
                          setPendingProductPreview((current) =>
                            current
                              ? {
                                  ...current,
                                  splitMarker: event.target.value,
                                }
                              : current,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void resplitProductPreview()
                          }
                        }}
                        placeholder="例如：*****"
                      />
                    </label>
                    <div className="readonly-banner subtle full">
                      <span>多产品在一个文档下，可设置分割标记做准确切分。输入后按 Enter 或点击重新切分。</span>
                    </div>
                    <div className="panel-actions full">
                      <button type="button" className="ghost" onClick={() => void resplitProductPreview()} disabled={isBusy}>
                        重新切分
                      </button>
                    </div>
                  </div>
                  <div className="preview-list">
                    {pendingProductPreview.items.map((item, index) => (
                      <article key={`${item.name}-${index}`} className="preview-card">
                        <div className="panel-head compact">
                          <div>
                            <p className="panel-kicker">CANDIDATE {index + 1}</p>
                            <h3>{item.name || `产品 ${index + 1}`}</h3>
                          </div>
                          <button type="button" className="ghost danger" onClick={() => removePreviewProduct(index)}>
                            移除
                          </button>
                        </div>
                        <div className="form-grid preview-form-grid">
                          <label>
                            <span>产品名</span>
                            <input value={item.name} onChange={(event) => updatePreviewProduct(index, 'name', event.target.value)} />
                          </label>
                          <label>
                            <span>来源</span>
                            <input value={item.sourceName} onChange={(event) => updatePreviewProduct(index, 'sourceName', event.target.value)} />
                          </label>
                          <label className="full">
                            <span>产品说明</span>
                            <textarea rows={4} value={item.content} onChange={(event) => updatePreviewProduct(index, 'content', event.target.value)} />
                          </label>
                          <label>
                            <span>关键词</span>
                            <textarea
                              rows={3}
                              value={item.keywords.join('\n')}
                              onChange={(event) => updatePreviewProduct(index, 'keywords', linesToList(event.target.value))}
                            />
                          </label>
                          <label>
                            <span>适用场景</span>
                            <textarea
                              rows={3}
                              value={item.scenarios.join('\n')}
                              onChange={(event) => updatePreviewProduct(index, 'scenarios', linesToList(event.target.value))}
                            />
                          </label>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
              <div className="readonly-banner full subtle">
                <span>上传单一或多产品文档都可以。上传后可在上方设置分割标记并重新切分。</span>
              </div>
              <label>
                <span>产品名</span>
                <input
                  value={productForm.name}
                  onChange={(event) => setProductForm((prev) => ({ ...prev, name: event.target.value }))}
                  readOnly={productProcessing}
                />
              </label>
              <label>
                <span>来源</span>
                <input
                  value={productForm.sourceName}
                  onChange={(event) => setProductForm((prev) => ({ ...prev, sourceName: event.target.value }))}
                  readOnly={productProcessing}
                />
              </label>
              <label className="full">
                <span>产品说明</span>
                <textarea
                  rows={6}
                  value={productForm.content}
                  onChange={(event) => setProductForm((prev) => ({ ...prev, content: event.target.value }))}
                  readOnly={productProcessing}
                />
              </label>
              <label>
                <span>关键词</span>
                <textarea
                  rows={3}
                  value={productForm.keywords.join('\n')}
                  onChange={(event) =>
                    setProductForm((prev) => ({ ...prev, keywords: linesToList(event.target.value) }))
                  }
                  readOnly={productProcessing}
                />
              </label>
              <label>
                <span>适用场景</span>
                <textarea
                  rows={3}
                  value={productForm.scenarios.join('\n')}
                  onChange={(event) =>
                    setProductForm((prev) => ({ ...prev, scenarios: linesToList(event.target.value) }))
                  }
                  readOnly={productProcessing}
                />
              </label>
              <div className="panel-actions full product-editor-actions">
                <button type="button" onClick={() => void saveProduct()} disabled={isBusy || productProcessing}>
                  保存产品
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>
    )
  }

  function renderOutput() {
    const isOutputProcessing = processKind === 'article' || processKind === 'translate'
    const bodyRefreshing = isOutputProcessing && Boolean(latestRecord) && articleRefreshTarget === 'body'
    const translationRefreshing = processKind === 'translate' && Boolean(latestRecord) && articleRefreshTarget === 'translate'
    const tdkRefreshing =
      isOutputProcessing && Boolean(latestRecord) && (articleRefreshTarget === 'body' || articleRefreshTarget === 'tdk')
    const hasZhBody = Boolean(latestRecord?.bodyZh.trim())
    const hasEnBody = Boolean(latestRecord?.bodyEn.trim())
    const hasZhTdk = Boolean(
      latestRecord && (latestRecord.tdkTitleZh.trim() || latestRecord.tdkDescriptionZh.trim() || latestRecord.tdkKeywordsZh.trim()),
    )
    const hasEnTdk = Boolean(
      latestRecord && (latestRecord.tdkTitleEn.trim() || latestRecord.tdkDescriptionEn.trim() || latestRecord.tdkKeywordsEn.trim()),
    )
    const translationTarget =
      latestRecord && !hasEnBody && hasZhBody ? 'en' : latestRecord && !hasZhBody && hasEnBody ? 'zh' : null
    const bodyTitle =
      latestRecord && hasZhBody && !hasEnBody ? latestRecord.selectedTitleZh : latestRecord?.selectedTitleEn || latestRecord?.selectedTitleZh
    const processingLabel =
      articleRefreshTarget === 'translate'
        ? '正在生成翻译...'
        : articleRefreshTarget === 'tdk'
          ? '正在生成TDK...'
          : '正在生成正文...'
    const timingSnapshot = latestRecord ? readTimingSnapshot(latestRecord.meta) : null

    return (
      <main className="content-grid output-grid">
        <section className="panel output-side">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">GENERATOR INPUT</p>
              <h2>输出参数</h2>
            </div>
          </div>

          <div className="form-grid">
            <label>
              <span>文案方向</span>
              <select value={direction} onChange={(event) => setDirection(event.target.value)}>
                {directions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>标题 Prompt</span>
              <select
                value={titlePromptId ?? ''}
                onChange={(event) => setTitlePromptId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">请选择标题 Prompt</option>
                {filteredTitlePrompts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="full">
              <span>关键词</span>
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="可选，作为标题与正文上下文输入"
              />
            </label>
            <label>
              <span>搭配产品</span>
              <select
                value={productId ?? ''}
                onChange={(event) => setProductId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">不指定产品</option>
                {data?.products.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>导出格式</span>
              <div className="segmented">
                <button
                  type="button"
                  className={exportFormat === 'md' ? 'active' : ''}
                  onClick={() => setExportFormat('md')}
                >
                  MD
                </button>
                <button
                  type="button"
                  className={exportFormat === 'docx' ? 'active' : ''}
                  onClick={() => setExportFormat('docx')}
                >
                  DOCX
                </button>
              </div>
            </label>
            <label>
              <span>输出语言</span>
              <select value={outputLanguage} onChange={(event) => setOutputLanguage(event.target.value as OutputLanguage)}>
                <option value="zh">仅中文</option>
                <option value="en">仅英文</option>
              </select>
            </label>
            {titles.length ? (
              <>
                <label className="full">
                  <span>文章生成 Prompt</span>
                  <select
                    value={articlePromptId ?? ''}
                    onChange={(event) => setArticlePromptId(event.target.value ? Number(event.target.value) : null)}
                  >
                    <option value="">请选择文章生成 Prompt</option>
                    {filteredArticlePrompts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            <label className="full">
              <span>隐藏口令</span>
              <input
                value={systemCode}
                onChange={(event) => setSystemCode(event.target.value)}
                placeholder="输入系统口令可切换模式"
              />
            </label>
          </div>

          <div className="panel-actions">
            {titles.length ? (
              <>
                <button
                  type="button"
                  onClick={() => void generateArticle({ refreshTarget: latestRecord ? 'body' : 'initial', preserveNotice: Boolean(latestRecord) })}
                  disabled={isBusy || (!latestRecord && (!selectedTitle || !articlePromptId))}
                >
                  {isOutputProcessing && articleRefreshTarget !== 'tdk' ? '重新生成中...' : '生成正文 + TDK'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void generateTitleOptions()}
                  disabled={isBusy || !direction || !titlePromptId}
                >
                  重新生成标题
                </button>
                {latestRecord ? (
                  <button
                    type="button"
                    className="save-local-button"
                    onClick={() => void exportRecord(latestRecord.id, exportFormat)}
                    disabled={isBusy}
                  >
                    保存到本地
                  </button>
                ) : null}
              </>
            ) : (
              <button type="button" onClick={() => void generateTitleOptions()} disabled={isBusy || !direction || !titlePromptId}>
                生成 4 组选题
              </button>
            )}
          </div>

          {themeMode === 'brutal' ? (
            <section className="brutal-box">
              <div className="panel-head compact">
                <div>
                  <p className="panel-kicker">BRUTAL BATCH</p>
                  <h3>暴力生成</h3>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  <span>文章数量</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={batchCount}
                    onChange={(event) => setBatchCount(Number(event.target.value))}
                  />
                </label>
                <label className="full">
                  <span>文案方向范围</span>
                  <div className="tag-cloud">
                    {directions.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={batchDirections.includes(item) ? 'tag active' : 'tag'}
                        onClick={() =>
                          setBatchDirections((current) =>
                            current.includes(item)
                              ? current.filter((entry) => entry !== item)
                              : [...current, item],
                          )
                        }
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="full">
                  <span>产品范围</span>
                  <div className="tag-cloud">
                    {data?.products.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={batchProductIds.includes(item.id) ? 'tag active' : 'tag'}
                        onClick={() =>
                          setBatchProductIds((current) =>
                            current.includes(item.id)
                              ? current.filter((entry) => entry !== item.id)
                              : [...current, item.id],
                          )
                        }
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                </label>
              </div>
              <div className="panel-actions">
                <button type="button" className="danger-fill" onClick={() => void runBatch()} disabled={isBusy}>
                  开始暴力生成
                </button>
              </div>
            </section>
          ) : null}
        </section>

        <section className="panel output-main">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">OUTPUT STAGE</p>
              <h2>标题、正文与 TDK</h2>
            </div>
            <button type="button" className="ghost" onClick={clearOutputStage} disabled={isBusy || (!titles.length && !latestRecord)}>
              一键清空
            </button>
          </div>

          <section className="title-grid">
            {titles.length ? (
              titles.map((item, index) => (
                <article
                  key={`${item.zh}-${index}`}
                  className={selectedTitle?.zh === item.zh ? 'title-card active' : 'title-card'}
                  onClick={() => setSelectedTitle(item)}
                >
                  <div className="title-card-copy">
                    <p className="title-zh">{item.zh}</p>
                    <p className="title-en">{item.en}</p>
                  </div>
                  <button type="button" className="ghost title-refresh" onClick={(event) => {
                    event.stopPropagation()
                    void refreshSingleTitle(index)
                  }}>
                    刷新
                  </button>
                </article>
              ))
            ) : (
              <div className="placeholder-box">
                <p>先生成 4 组标题，中英会同步显示在这里。</p>
              </div>
            )}
          </section>
          {outputStatus ? (
            <div className={['output-inline-status', outputStatus.type].join(' ')}>
              {outputStatus.text}
            </div>
          ) : null}
          {timingSnapshot?.text ? <div className="output-timing-summary">{`${timingSnapshot.operationLabel} · ${timingSnapshot.text}`}</div> : null}
          {latestRecord ? (
            <section className="result-grid result-split">
              <article className="result-card body-card">
                <div className="panel-head compact">
                  <div>
                    <p className="panel-kicker">BODY</p>
                    <h3>{bodyTitle}</h3>
                  </div>
                </div>
                <div className="panel-actions output-actions">
                  {hasZhBody ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void copyArticle('中文正文', latestRecord.bodyZh, latestRecord.selectedTitleZh)}
                      disabled={isBusy && !translationRefreshing}
                    >
                      复制中文
                    </button>
                  ) : null}
                  {hasEnBody ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void copyArticle('英文正文', latestRecord.bodyEn, latestRecord.selectedTitleEn)}
                      disabled={isBusy && !translationRefreshing}
                    >
                      复制英文
                    </button>
                  ) : null}
                  {!bodyRefreshing && translationTarget ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void translateLatestRecord(translationTarget)}
                      disabled={isBusy}
                    >
                      {translationTarget === 'zh' ? '生成中文翻译' : '生成英文翻译'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void regenerateLatestRecord('body')}
                    disabled={isBusy}
                  >
                    {bodyRefreshing ? '重新生成中...' : '重新生成正文'}
                  </button>
                </div>
                <div className="stacked-output">
                  {bodyRefreshing ? (
                    <section className="output-loading">
                      <p>{processingLabel}</p>
                      <div className="inline-progress">
                        {currentProcessSteps.map((item, index) => (
                          <div
                            key={item}
                            className={[
                              'inline-progress-step',
                              index < processIndex ? 'done' : '',
                              index === processIndex ? 'active' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            <span>{String(index + 1).padStart(2, '0')}</span>
                            <strong>{item}</strong>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {hasZhBody ? (
                    <section className="output-block">
                      <p className="output-block-title">中文正文</p>
                      <div
                        className="copy-block copy-block-rich"
                        dangerouslySetInnerHTML={{ __html: buildRichTextHtml(latestRecord.bodyZh) }}
                      />
                    </section>
                  ) : null}
                  {hasEnBody ? (
                    <section className="output-block">
                      <p className="output-block-title">英文正文</p>
                      <div
                        className="copy-block copy-block-rich"
                        dangerouslySetInnerHTML={{ __html: buildRichTextHtml(latestRecord.bodyEn) }}
                      />
                    </section>
                  ) : null}
                  {translationRefreshing && translationTarget ? (
                    <section className="output-block">
                      <p className="output-block-title">{translationTarget === 'zh' ? '中文翻译生成中' : '英文翻译生成中'}</p>
                      <div className="output-loading compact">
                        <p>{processingLabel}</p>
                        <div className="inline-progress">
                          {currentProcessSteps.map((item, index) => (
                            <div
                              key={item}
                              className={[
                                'inline-progress-step',
                                index < processIndex ? 'done' : '',
                                index === processIndex ? 'active' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <span>{String(index + 1).padStart(2, '0')}</span>
                              <strong>{item}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    </section>
                  ) : null}
                </div>
              </article>

              <article className="result-card tdk-card">
                <div className="panel-head compact">
                  <div>
                    <p className="panel-kicker">TDK</p>
                    <h3>{latestRecord.direction}</h3>
                  </div>
                </div>
                <div className="panel-actions output-actions">
                  {!tdkRefreshing && hasZhTdk ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        void copyText(
                          '中文 TDK',
                          `Title: ${latestRecord.tdkTitleZh}\nDescription: ${latestRecord.tdkDescriptionZh}\nKeywords: ${latestRecord.tdkKeywordsZh}`,
                        )
                      }
                    >
                      复制中文
                    </button>
                  ) : null}
                  {!tdkRefreshing && hasEnTdk ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        void copyText(
                          '英文 TDK',
                          `Title: ${latestRecord.tdkTitleEn}\nDescription: ${latestRecord.tdkDescriptionEn}\nKeywords: ${latestRecord.tdkKeywordsEn}`,
                        )
                      }
                    >
                      复制英文
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void regenerateLatestRecord('tdk')}
                    disabled={isBusy}
                  >
                    {articleRefreshTarget === 'tdk' && isOutputProcessing ? '重新生成中...' : '重新生成TDK'}
                  </button>
                </div>
                <div className="stacked-output">
                  {tdkRefreshing ? (
                    <section className="output-loading">
                      <p>{processingLabel}</p>
                      <div className="inline-progress">
                        {currentProcessSteps.map((item, index) => (
                          <div
                            key={item}
                            className={[
                              'inline-progress-step',
                              index < processIndex ? 'done' : '',
                              index === processIndex ? 'active' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            <span>{String(index + 1).padStart(2, '0')}</span>
                            <strong>{item}</strong>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {!tdkRefreshing && hasZhTdk ? (
                    <section className="output-block">
                      <p className="output-block-title">中文 TDK</p>
                      <dl className="tdk-list">
                        <div>
                          <dt>Title</dt>
                          <dd>{latestRecord.tdkTitleZh}</dd>
                        </div>
                        <div>
                          <dt>Description</dt>
                          <dd>{latestRecord.tdkDescriptionZh}</dd>
                        </div>
                        <div>
                          <dt>Keywords</dt>
                          <dd>{latestRecord.tdkKeywordsZh}</dd>
                        </div>
                      </dl>
                    </section>
                  ) : null}
                  {!tdkRefreshing && hasEnTdk ? (
                    <section className="output-block">
                      <p className="output-block-title">英文 TDK</p>
                      <dl className="tdk-list">
                        <div>
                          <dt>Title</dt>
                          <dd>{latestRecord.tdkTitleEn}</dd>
                        </div>
                        <div>
                          <dt>Description</dt>
                          <dd>{latestRecord.tdkDescriptionEn}</dd>
                        </div>
                        <div>
                          <dt>Keywords</dt>
                          <dd>{latestRecord.tdkKeywordsEn}</dd>
                        </div>
                      </dl>
                    </section>
                  ) : null}
                </div>
              </article>
            </section>
          ) : (
            <div className="placeholder-box large">
              {isOutputProcessing ? (
                <>
                  <p>{processingLabel}</p>
                  <div className="inline-progress">
                    {currentProcessSteps.map((item, index) => (
                      <div
                        key={item}
                        className={[
                          'inline-progress-step',
                          index < processIndex ? 'done' : '',
                          index === processIndex ? 'active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <strong>{item}</strong>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p>正文、TDK、翻译结果和保存状态会显示在这里。</p>
              )}
            </div>
          )}

          {batchResults.length ? (
            <section className="batch-strip">
              {batchResults.map((item) => (
                <article key={item.id} className="batch-card">
                  <strong>{item.selectedTitleZh}</strong>
                  <p>{item.selectedTitleEn}</p>
                </article>
              ))}
            </section>
          ) : null}
        </section>
      </main>
    )
  }

  function renderHistory() {
    return (
      <main className="content-grid history-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="panel-kicker">RUN LOG</p>
              <h2>历史记录</h2>
            </div>
          </div>
          <div className="history-toolbar">
            <input
              value={historySearch}
              onChange={(event) => setHistorySearch(event.target.value)}
              placeholder="搜索标题或方向"
            />
            <select value={historyDirectionFilter} onChange={(event) => setHistoryDirectionFilter(event.target.value)}>
              <option value="all">全部方向</option>
              {historyDirections.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
          <div className="stack-list history-list">
            {filteredHistory.map((item) => (
              <article key={item.id} className="history-card">
                <div className="history-main">
                  <div>
                    <p className="history-title">{item.selectedTitleZh}</p>
                    <p className="history-sub">{item.selectedTitleEn}</p>
                  </div>
                  <div className="history-meta">
                    <span>{item.direction}</span>
                    <span>{item.mode === 'brutal' ? '暴力' : '标准'}</span>
                    <span>{formatTime(item.createdAt)}</span>
                  </div>
                </div>
                <div className="history-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => loadHistoryRecord(item)}
                  >
                    查看
                  </button>
                  <button type="button" className="ghost" onClick={() => void exportRecord(item.id, 'md')}>
                    导出 MD
                  </button>
                  <button type="button" className="ghost" onClick={() => void exportRecord(item.id, 'docx')}>
                    导出 DOCX
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void copyArticle('中文正文', item.bodyZh, item.selectedTitleZh)}
                  >
                    复制中文
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    )
  }
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? ((await response.json()) as T & { error?: string })
    : null

  if (!response.ok) {
    if (payload?.error) {
      throw new Error(payload.error)
    }
    const text = await response.text()
    if (response.status === 404) {
      throw new Error('本地服务仍是旧版本，请重启启动脚本后再试。')
    }
    throw new Error(text || '请求失败。')
  }

  if (!payload) {
    throw new Error('服务返回了非 JSON 响应，请重启本地服务后重试。')
  }
  return payload
}

async function requestForm<T>(url: string, body: FormData) {
  const response = await fetch(url, {
    method: 'POST',
    body,
  })
  const payload = (await response.json()) as T & { error?: string }
  if (!response.ok) {
    throw new Error(payload.error || '请求失败。')
  }
  return payload
}

function linesToList(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return '发生未知错误。'
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function fileNameFromPath(value: string) {
  return value.split(/[\\/]/).pop() || value
}

export default App
