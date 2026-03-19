import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import cors from 'cors'
import express from 'express'
import mammoth from 'mammoth'
import multer from 'multer'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'

type JsonRecord = Record<string, unknown>
type ProcessorMode = 'llm' | 'rule'
type OutputLanguage = 'zh-en' | 'zh' | 'en'
type ProductDraft = {
  name: string
  content: string
  keywords: string[]
  scenarios: string[]
  sourceName: string
}

type TitlePromptTemplate = {
  id: number
  name: string
  direction: string
  prompt: string
  createdAt: string
  updatedAt: string
}

type PromptTemplate = {
  id: number
  name: string
  direction: string
  bodyPrompt: string
  tdkPrompt: string
  tdkRuleId: number | null
  includeCompanyProfile: boolean
  createdAt: string
  updatedAt: string
}

type TdkRule = {
  id: number
  name: string
  titleRule: string
  descriptionRule: string
  keywordsRule: string
  mustInclude: string[]
  forbiddenWords: string[]
  createdAt: string
  updatedAt: string
}

type Product = {
  id: number
  name: string
  content: string
  keywords: string[]
  scenarios: string[]
  sourceName: string
  createdAt: string
  updatedAt: string
}

type HistoryRecord = {
  id: number
  direction: string
  productId: number | null
  mode: 'standard' | 'brutal'
  titleOptions: { zh: string; en: string; reason: string }[]
  selectedTitleZh: string
  selectedTitleEn: string
  bodyZh: string
  bodyEn: string
  tdkTitleZh: string
  tdkTitleEn: string
  tdkDescriptionZh: string
  tdkDescriptionEn: string
  tdkKeywordsZh: string
  tdkKeywordsEn: string
  promptTemplateId: number | null
  tdkRuleId: number | null
  meta: JsonRecord
  exportMdPath: string | null
  exportDocxPath: string | null
  createdAt: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const DATA_DIR = path.join(ROOT_DIR, 'data')
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const EXPORT_DIR = path.join(DATA_DIR, 'exports')
const DIST_DIR = path.join(ROOT_DIR, 'dist')
const TMP_DOC_DIR = path.join(ROOT_DIR, 'tmp', 'docs')
const DB_PATH = path.join(DATA_DIR, 'app.sqlite')
const KEY_PATH = path.join(DATA_DIR, 'secret.key')
const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download'
const DEFAULT_OUTPUT_DIR = EXPORT_DIR
const execFileAsync = promisify(execFile)
const PYTHON_BIN = path.join(ROOT_DIR, '.venv', 'bin', 'python')
const DOCX_EXPORT_SCRIPT = path.join(ROOT_DIR, 'scripts', 'export_docx.py')

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true }))

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
})

await ensureDirs()

const db = new DatabaseSync(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    api_url TEXT NOT NULL DEFAULT '',
    api_key_encrypted TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '',
    output_dir TEXT NOT NULL DEFAULT '${DEFAULT_OUTPUT_DIR.replace(/'/g, "''")}',
    product_split_marker TEXT NOT NULL DEFAULT '',
    title_timeout_sec INTEGER NOT NULL DEFAULT 90,
    article_timeout_sec INTEGER NOT NULL DEFAULT 35,
    english_timeout_sec INTEGER NOT NULL DEFAULT 25,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    direction TEXT NOT NULL,
    title_prompt TEXT NOT NULL,
    body_prompt TEXT NOT NULL,
    tdk_prompt TEXT NOT NULL,
    tdk_rule_id INTEGER,
    include_company_profile INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS title_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    direction TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tdk_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    direction TEXT NOT NULL,
    title_rule TEXT NOT NULL,
    description_rule TEXT NOT NULL,
    keywords_rule TEXT NOT NULL,
    must_include TEXT NOT NULL DEFAULT '[]',
    forbidden_words TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS company_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source_name TEXT NOT NULL DEFAULT '',
    raw_content TEXT NOT NULL DEFAULT '',
    strengths TEXT NOT NULL DEFAULT '[]',
    tone TEXT NOT NULL DEFAULT '',
    scenarios TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    scenarios TEXT NOT NULL DEFAULT '[]',
    source_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    product_id INTEGER,
    mode TEXT NOT NULL DEFAULT 'standard',
    title_options TEXT NOT NULL DEFAULT '[]',
    selected_title_zh TEXT NOT NULL DEFAULT '',
    selected_title_en TEXT NOT NULL DEFAULT '',
    body_zh TEXT NOT NULL DEFAULT '',
    body_en TEXT NOT NULL DEFAULT '',
    tdk_title_zh TEXT NOT NULL DEFAULT '',
    tdk_title_en TEXT NOT NULL DEFAULT '',
    tdk_description_zh TEXT NOT NULL DEFAULT '',
    tdk_description_en TEXT NOT NULL DEFAULT '',
    tdk_keywords_zh TEXT NOT NULL DEFAULT '',
    tdk_keywords_en TEXT NOT NULL DEFAULT '',
    prompt_template_id INTEGER,
    tdk_rule_id INTEGER,
    meta TEXT NOT NULL DEFAULT '{}',
    export_md_path TEXT,
    export_docx_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)

ensureSettingColumn('product_split_marker', "TEXT NOT NULL DEFAULT ''")
ensureSettingColumn('title_timeout_sec', 'INTEGER NOT NULL DEFAULT 90')
ensureSettingColumn('article_timeout_sec', 'INTEGER NOT NULL DEFAULT 35')
ensureSettingColumn('english_timeout_sec', 'INTEGER NOT NULL DEFAULT 25')
ensureTableColumn('prompt_templates', 'tdk_rule_id', 'INTEGER')
ensureTableColumn('prompt_templates', 'include_company_profile', 'INTEGER NOT NULL DEFAULT 0')

seedDefaults()
backfillTitlePromptsFromLegacyPrompts()
backfillPromptRuleBindings()

app.get('/api/bootstrap', async (_req, res) => {
  res.json(getBootstrapPayload())
})

app.post('/api/settings', async (req, res) => {
  const payload = z
    .object({
      apiUrl: z.string().trim(),
      apiKey: z.string().trim(),
      modelName: z.string().trim(),
      outputDir: z.string().trim().optional(),
      productSplitMarker: z.string().optional(),
      titleTimeoutSec: z.coerce.number().int().min(5).max(300).optional(),
      articleTimeoutSec: z.coerce.number().int().min(5).max(300).optional(),
      englishTimeoutSec: z.coerce.number().int().min(5).max(300).optional(),
    })
    .parse(req.body)

  const outputDir = payload.outputDir || DEFAULT_OUTPUT_DIR
  await fs.mkdir(outputDir, { recursive: true })

  db.prepare(
    `UPDATE app_settings
      SET api_url = ?, api_key_encrypted = ?, model_name = ?, output_dir = ?, product_split_marker = ?, title_timeout_sec = ?, article_timeout_sec = ?, english_timeout_sec = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`,
  ).run(
    payload.apiUrl,
    encrypt(payload.apiKey),
    payload.modelName,
    outputDir,
    payload.productSplitMarker?.trim() || '',
    payload.titleTimeoutSec ?? 90,
    payload.articleTimeoutSec ?? 35,
    payload.englishTimeoutSec ?? 25,
  )

  res.json(getBootstrapPayload())
})

app.post('/api/settings/test-llm', async (req, res) => {
  const payload = z
    .object({
      apiUrl: z.string().trim().min(1),
      apiKey: z.string().trim().min(1),
      modelName: z.string().trim().min(1),
      outputDir: z.string().trim().optional(),
    })
    .parse(req.body)

  const settings = {
    apiUrl: payload.apiUrl,
    apiKey: payload.apiKey,
    modelName: payload.modelName,
    outputDir: payload.outputDir || DEFAULT_OUTPUT_DIR,
    productSplitMarker: '',
    titleTimeoutSec: 90,
    articleTimeoutSec: 35,
    englishTimeoutSec: 25,
    updatedAt: '',
  }

  const raw = await llmRequest({
    settings,
    prompt: '请输出严格 JSON：{"status":"ok","reply":"连接成功"}',
    timeoutMs: 15000,
    responseFormat: 'json_object',
  })
  const parsed = safeJson<{ status?: string; reply?: string }>(extractJsonBlock(raw), {})

  res.json({
    success: true,
    message: parsed.reply || raw.slice(0, 160) || '连接成功',
  })
})

app.post('/api/system/select-output-dir', async (_req, res) => {
  const outputDir = await chooseDirectoryWithSystemDialog()

  if (!outputDir) {
    res.json({ cancelled: true })
    return
  }

  await fs.mkdir(outputDir, { recursive: true })
  res.json({ cancelled: false, outputDir })
})

app.post('/api/system/open-path', async (req, res) => {
  const payload = z
    .object({
      path: z.string().trim().min(1),
    })
    .parse(req.body)

  await openPathInSystem(payload.path)
  res.json({ success: true })
})

app.post('/api/title-prompts', (req, res) => {
  const payload = z
    .object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(1),
      direction: z.string().trim().min(1),
      prompt: z.string().trim().min(1),
    })
    .parse(req.body)

  let savedId = payload.id ?? null

  if (payload.id) {
    db.prepare(
      `UPDATE title_prompts
        SET name = ?, direction = ?, prompt = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(payload.name, payload.direction, payload.prompt, payload.id)
  } else {
    const result = db
      .prepare(
        `INSERT INTO title_prompts (name, direction, prompt)
          VALUES (?, ?, ?)`,
      )
      .run(payload.name, payload.direction, payload.prompt)
    savedId = Number(result.lastInsertRowid)
  }

  res.json({ titlePrompts: getTitlePrompts(), prompts: getPromptTemplates(), savedId })
})

app.delete('/api/title-prompts/:id', (req, res) => {
  const id = Number(req.params.id)
  const target = getTitlePrompts().find((item) => item.id === id)
  db.prepare(`DELETE FROM title_prompts WHERE id = ?`).run(id)
  if (target) {
    const replacementDirection = getTitlePrompts().find((item) => item.id !== id && item.direction === target.direction)
      ? target.direction
      : ''
    if (!replacementDirection) {
      db.prepare(`UPDATE prompt_templates SET direction = '' WHERE direction = ?`).run(target.direction)
    }
  }
  res.json({ titlePrompts: getTitlePrompts(), prompts: getPromptTemplates() })
})

app.post('/api/prompts', (req, res) => {
  const payload = z
    .object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(1),
      direction: z.string().trim().min(1),
      bodyPrompt: z.string().trim().min(1),
      tdkPrompt: z.string().trim().min(1),
      tdkRuleId: z.number().int().positive().nullable().optional(),
      includeCompanyProfile: z.boolean().optional(),
    })
    .parse(req.body)

  let savedId = payload.id ?? null

  if (payload.id) {
    db.prepare(
      `UPDATE prompt_templates
        SET name = ?, direction = ?, body_prompt = ?, tdk_prompt = ?, tdk_rule_id = ?, include_company_profile = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(
      payload.name,
      payload.direction,
      payload.bodyPrompt,
      payload.tdkPrompt,
      payload.tdkRuleId ?? null,
      payload.includeCompanyProfile ? 1 : 0,
      payload.id,
    )
  } else {
    const result = db.prepare(
      `INSERT INTO prompt_templates (name, direction, title_prompt, body_prompt, tdk_prompt, tdk_rule_id, include_company_profile)
        VALUES (?, ?, '', ?, ?, ?, ?)`,
    ).run(
      payload.name,
      payload.direction,
      payload.bodyPrompt,
      payload.tdkPrompt,
      payload.tdkRuleId ?? null,
      payload.includeCompanyProfile ? 1 : 0,
    )
    savedId = Number(result.lastInsertRowid)
  }

  res.json({ prompts: getPromptTemplates(), savedId })
})

app.delete('/api/prompts/:id', (req, res) => {
  db.prepare(`DELETE FROM prompt_templates WHERE id = ?`).run(Number(req.params.id))
  res.json({ prompts: getPromptTemplates() })
})

app.post('/api/rules', (req, res) => {
  const payload = z
    .object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(1),
      titleRule: z.string().trim().min(1),
      descriptionRule: z.string().trim().min(1),
      keywordsRule: z.string().trim().min(1),
      mustInclude: z.array(z.string()),
      forbiddenWords: z.array(z.string()),
    })
    .parse(req.body)

  let savedId = payload.id ?? null

  if (payload.id) {
    db.prepare(
      `UPDATE tdk_rules
        SET name = ?, direction = ?, title_rule = ?, description_rule = ?, keywords_rule = ?, must_include = ?, forbidden_words = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(
      payload.name,
      '',
      payload.titleRule,
      payload.descriptionRule,
      payload.keywordsRule,
      JSON.stringify(payload.mustInclude),
      JSON.stringify(payload.forbiddenWords),
      payload.id,
    )
  } else {
    const result = db.prepare(
      `INSERT INTO tdk_rules (name, direction, title_rule, description_rule, keywords_rule, must_include, forbidden_words)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      payload.name,
      '',
      payload.titleRule,
      payload.descriptionRule,
      payload.keywordsRule,
      JSON.stringify(payload.mustInclude),
      JSON.stringify(payload.forbiddenWords),
    )
    savedId = Number(result.lastInsertRowid)
  }

  res.json({ rules: getTdkRules(), prompts: getPromptTemplates(), savedId })
})

app.delete('/api/rules/:id', (req, res) => {
  const id = Number(req.params.id)
  db.prepare(`UPDATE prompt_templates SET tdk_rule_id = NULL WHERE tdk_rule_id = ?`).run(id)
  db.prepare(`DELETE FROM tdk_rules WHERE id = ?`).run(id)
  res.json({ rules: getTdkRules(), prompts: getPromptTemplates() })
})

app.post('/api/company/text', async (req, res) => {
  const payload = z
    .object({
      rawContent: z.string(),
      sourceName: z.string().optional(),
      strengths: z.array(z.string()).optional(),
      tone: z.string().optional(),
      scenarios: z.array(z.string()).optional(),
    })
    .parse(req.body)

  const extracted = buildCompanyInsights(payload.rawContent)
  db.prepare(
    `UPDATE company_profile
      SET source_name = ?, raw_content = ?, strengths = ?, tone = ?, scenarios = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`,
  ).run(
    payload.sourceName || '手动输入',
    payload.rawContent,
    JSON.stringify(payload.strengths ?? extracted.strengths),
    payload.tone ?? extracted.tone,
    JSON.stringify(payload.scenarios ?? extracted.scenarios),
  )

  res.json({ company: getCompanyProfile() })
})

app.post('/api/company/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '未收到文件。' })
    return
  }

  const originalName = normalizeUploadName(req.file.originalname)
  const rawContent = await extractDocumentText(req.file.path, originalName)
  const settings = getSettings()
  const extractedFromLlm = await extractCompanyProfileFromDocument({
    settings,
    rawContent,
    sourceName: originalName,
  })
  const extracted = extractedFromLlm ?? buildCompanyInsights(rawContent)
  const processor: ProcessorMode = extractedFromLlm ? 'llm' : 'rule'

  db.prepare(
    `UPDATE company_profile
      SET source_name = ?, raw_content = ?, strengths = ?, tone = ?, scenarios = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`,
  ).run(
    originalName,
    rawContent,
    JSON.stringify(extracted.strengths),
    extracted.tone,
    JSON.stringify(extracted.scenarios),
  )

  await fs.rm(req.file.path, { force: true })
  res.json({
    company: getCompanyProfile(),
    processor,
    processorMessage:
      processor === 'llm'
        ? '此次由 LLM 整理公司资料并回填。'
        : '此次由规则进行输入，未使用 LLM 整理公司资料。',
  })
})

app.post('/api/products', (req, res) => {
  const payload = z
    .object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(1),
      content: z.string().trim().min(1),
      keywords: z.array(z.string()).default([]),
      scenarios: z.array(z.string()).default([]),
      sourceName: z.string().trim().optional(),
    })
    .parse(req.body)

  if (payload.id) {
    db.prepare(
      `UPDATE products
        SET name = ?, content = ?, keywords = ?, scenarios = ?, source_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(
      payload.name,
      payload.content,
      JSON.stringify(payload.keywords),
      JSON.stringify(payload.scenarios),
      payload.sourceName || '手动输入',
      payload.id,
    )
  } else {
    db.prepare(
      `INSERT INTO products (name, content, keywords, scenarios, source_name)
        VALUES (?, ?, ?, ?, ?)`,
    ).run(
      payload.name,
      payload.content,
      JSON.stringify(payload.keywords),
      JSON.stringify(payload.scenarios),
      payload.sourceName || '手动输入',
    )
  }

  res.json({ products: getProducts() })
})

app.post('/api/products/preview-upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '未收到文件。' })
    return
  }

  const originalName = normalizeUploadName(req.file.originalname)
  const rawContent = await extractDocumentText(req.file.path, originalName)
  const fileName = req.body.name?.trim() || originalName.replace(/\.[^.]+$/, '')
  const splitMarker = resolveProductSplitMarker(req.body)
  const extraction = splitProductsFromDocument({
    rawContent,
    fallbackName: fileName,
    sourceName: originalName,
    splitMarker,
  })
  let extractedProducts = extraction.items
  const processor: ProcessorMode = 'rule'

  if (!extractedProducts.length) {
    const insights = buildProductInsights(rawContent)
    extractedProducts = [
      {
        name: fileName,
        content: rawContent,
        keywords: insights.keywords,
        scenarios: insights.scenarios,
        sourceName: originalName,
      },
    ]
  }

  await fs.rm(req.file.path, { force: true })
  res.json({
    previewProducts: extractedProducts,
    importCount: extractedProducts.length,
    processor,
    sourceName: originalName,
    rawContent,
    fallbackName: fileName,
    splitMarker,
    processorMessage: `此次由规则进行输入。${extraction.reason ? `说明：${extraction.reason}` : ''}`,
  })
})

app.post('/api/products/preview-text', (req, res) => {
  const payload = z
    .object({
      rawContent: z.string(),
      fallbackName: z.string().trim().min(1),
      sourceName: z.string().trim().min(1),
      productSplitMarker: z.string().optional(),
    })
    .parse(req.body)

  const splitMarker = (payload.productSplitMarker || '').trim()
  const extraction = splitProductsFromDocument({
    rawContent: payload.rawContent,
    fallbackName: payload.fallbackName,
    sourceName: payload.sourceName,
    splitMarker,
  })
  let extractedProducts = extraction.items

  if (!extractedProducts.length) {
    const insights = buildProductInsights(payload.rawContent)
    extractedProducts = [
      {
        name: payload.fallbackName,
        content: payload.rawContent,
        keywords: insights.keywords,
        scenarios: insights.scenarios,
        sourceName: payload.sourceName,
      },
    ]
  }

  res.json({
    previewProducts: extractedProducts,
    importCount: extractedProducts.length,
    processor: 'rule' as const,
    sourceName: payload.sourceName,
    rawContent: payload.rawContent,
    fallbackName: payload.fallbackName,
    splitMarker,
    processorMessage: `此次由规则进行输入。${extraction.reason ? `说明：${extraction.reason}` : ''}`,
  })
})

app.post('/api/products/confirm-import', (req, res) => {
  const payload = z
    .object({
      items: z
        .array(
          z.object({
            name: z.string().trim().min(1),
            content: z.string().trim().min(1),
            keywords: z.array(z.string()).default([]),
            scenarios: z.array(z.string()).default([]),
            sourceName: z.string().trim().optional(),
          }),
        )
        .min(1),
    })
    .parse(req.body)

  for (const item of payload.items) {
    db.prepare(
      `INSERT INTO products (name, content, keywords, scenarios, source_name)
        VALUES (?, ?, ?, ?, ?)`,
    ).run(
      item.name,
      item.content,
      JSON.stringify(item.keywords),
      JSON.stringify(item.scenarios),
      item.sourceName || '导入确认',
    )
  }

  res.json({
    products: getProducts(),
    importCount: payload.items.length,
  })
})

app.delete('/api/products/:id', (req, res) => {
  db.prepare(`DELETE FROM products WHERE id = ?`).run(Number(req.params.id))
  res.json({ products: getProducts() })
})

app.post('/api/generate/titles', async (req, res) => {
  const payload = z
    .object({
      direction: z.string().trim().min(1),
      titlePromptId: z.number().int().positive().nullable().optional(),
      keyword: z.string().trim().optional(),
      productId: z.number().int().positive().nullable(),
    })
    .parse(req.body)

  const settings = getSettings()
  const titlePrompt = pickTitlePrompt(payload.direction, payload.titlePromptId ?? null)
  const product = payload.productId ? getProductById(payload.productId) : null
  const company = getCompanyProfile()

  if (!settings.apiUrl || !settings.apiKey || !settings.modelName) {
    res.status(400).json({ error: '请先在设置区填写 API URL、API Key 和模型名称。' })
    return
  }

  const titles = await generateTitles({
    settings,
    direction: payload.direction,
    titlePrompt,
    keyword: payload.keyword?.trim() || '',
    company,
    product,
  })

  if (!titles.length) {
    res.status(502).json({ error: '标题生成结果为空，请调整 Prompt 或模型配置后重试。' })
    return
  }

  res.json({
    titles,
    selectedTitlePromptId: titlePrompt?.id ?? null,
  })
})

app.post('/api/generate/article', async (req, res) => {
  const payload = z
    .object({
      direction: z.string().trim().min(1),
      promptTemplateId: z.number().int().positive().nullable().optional(),
      keyword: z.string().trim().optional(),
      outputLanguage: z.enum(['zh-en', 'zh', 'en']).default('zh-en'),
      productId: z.number().int().positive().nullable(),
      mode: z.enum(['standard', 'brutal']).default('standard'),
      titles: z.array(
        z.object({
          zh: z.string(),
          en: z.string(),
          reason: z.string().optional().default(''),
        }),
      ),
      selectedTitle: z.object({
        zh: z.string().trim().min(1),
        en: z.string().trim().min(1),
      }),
      quantity: z.number().int().min(1).max(10).default(1),
      exportFormat: z.enum(['md', 'docx']),
    })
    .parse(req.body)

  const settings = getSettings()
  const company = getCompanyProfile()
  const product = payload.productId ? getProductById(payload.productId) : null
  const template = payload.promptTemplateId
    ? getPromptTemplates().find((item) => item.id === payload.promptTemplateId) ?? pickPromptTemplate(payload.direction)
    : pickPromptTemplate(payload.direction)
  const rule = pickRule(payload.direction, template)

  if (!settings.apiUrl || !settings.apiKey || !settings.modelName) {
    res.status(400).json({ error: '请先完成大模型配置。' })
    return
  }

  const createdRecords: HistoryRecord[] = []
  const savedPaths: string[] = []

  for (let index = 0; index < payload.quantity; index += 1) {
    const article = await generateArticle({
      settings,
      direction: payload.direction,
      keyword: payload.keyword?.trim() || '',
      outputLanguage: payload.outputLanguage,
      company,
      product,
      template,
      rule,
      selectedTitle: payload.selectedTitle,
    })

    const result = db
      .prepare(
        `INSERT INTO history (
          direction, product_id, mode, title_options, selected_title_zh, selected_title_en, body_zh, body_en,
          tdk_title_zh, tdk_title_en, tdk_description_zh, tdk_description_en, tdk_keywords_zh, tdk_keywords_en,
          prompt_template_id, tdk_rule_id, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payload.direction,
        payload.productId,
        payload.mode,
        JSON.stringify(payload.titles),
        payload.selectedTitle.zh,
        payload.selectedTitle.en,
        article.bodyZh,
        article.bodyEn,
        article.tdk.titleZh,
        article.tdk.titleEn,
        article.tdk.descriptionZh,
        article.tdk.descriptionEn,
        article.tdk.keywordsZh,
        article.tdk.keywordsEn,
        template?.id ?? null,
        rule?.id ?? null,
        JSON.stringify({
          productName: product?.name ?? null,
          promptName: template?.name ?? null,
          ruleName: rule?.name ?? null,
          keyword: payload.keyword?.trim() || '',
          variantIndex: index + 1,
          outputLanguage: payload.outputLanguage,
          processor: 'llm',
        }),
      )

    const historyId = Number(result.lastInsertRowid)
    const savedPath = await exportHistory(historyId, payload.exportFormat)
    const fieldName = payload.exportFormat === 'md' ? 'export_md_path' : 'export_docx_path'
    db.prepare(`UPDATE history SET ${fieldName} = ? WHERE id = ?`).run(savedPath, historyId)
    createdRecords.push(getHistoryById(historyId))
    savedPaths.push(savedPath)
  }

  res.json({
    records: createdRecords,
    record: createdRecords[0] ?? null,
    savedPath: savedPaths[0] ?? '',
    savedPaths,
    history: getHistory(),
  })
})

app.post('/api/history/:id/regenerate', async (req, res) => {
  const historyId = Number(req.params.id)
  if (!Number.isFinite(historyId)) {
    res.status(400).json({ error: '无效的历史记录 ID。' })
    return
  }

  const payload = z
    .object({
      target: z.enum(['body', 'tdk']),
    })
    .parse(req.body)

  const record = getHistoryById(historyId)
  const settings = getSettings()
  const company = getCompanyProfile()
  const product = record.productId ? getProductById(record.productId) : null
  const template = record.promptTemplateId
    ? getPromptTemplates().find((item) => item.id === record.promptTemplateId) ?? pickPromptTemplate(record.direction)
    : pickPromptTemplate(record.direction)
  const rule =
    (record.tdkRuleId ? getTdkRules().find((item) => item.id === record.tdkRuleId) : null) ?? pickRule(record.direction, template)
  const outputLanguage = resolveOutputLanguage(record.meta.outputLanguage)
  const keyword = typeof record.meta.keyword === 'string' ? record.meta.keyword : ''
  const selectedTitle = { zh: record.selectedTitleZh, en: record.selectedTitleEn }

  if (!settings.apiUrl || !settings.apiKey || !settings.modelName) {
    res.status(400).json({ error: '请先完成大模型配置。' })
    return
  }

  if (payload.target === 'body') {
    const article = await generateArticle({
      settings,
      direction: record.direction,
      keyword,
      outputLanguage,
      company,
      product,
      template,
      rule,
      selectedTitle,
    })

    const nextMeta = {
      ...record.meta,
      productName: product?.name ?? null,
      promptName: template?.name ?? null,
      ruleName: rule?.name ?? null,
      keyword,
      outputLanguage,
      processor: 'llm',
    }

    db.prepare(
      `UPDATE history
       SET body_zh = ?, body_en = ?,
           tdk_title_zh = ?, tdk_title_en = ?,
           tdk_description_zh = ?, tdk_description_en = ?,
           tdk_keywords_zh = ?, tdk_keywords_en = ?,
           prompt_template_id = ?, tdk_rule_id = ?, meta = ?
       WHERE id = ?`,
    ).run(
      article.bodyZh,
      article.bodyEn,
      article.tdk.titleZh,
      article.tdk.titleEn,
      article.tdk.descriptionZh,
      article.tdk.descriptionEn,
      article.tdk.keywordsZh,
      article.tdk.keywordsEn,
      template?.id ?? null,
      rule?.id ?? null,
      JSON.stringify(nextMeta),
      historyId,
    )
  } else {
    const tdk = await generateTdkForExistingBody({
      settings,
      direction: record.direction,
      keyword,
      outputLanguage,
      selectedTitle,
      bodyZh: record.bodyZh,
      bodyEn: record.bodyEn,
      template,
      rule,
    })

    const nextMeta = {
      ...record.meta,
      promptName: template?.name ?? null,
      ruleName: rule?.name ?? null,
      keyword,
      outputLanguage,
      processor: 'llm',
    }

    db.prepare(
      `UPDATE history
       SET tdk_title_zh = ?, tdk_title_en = ?,
           tdk_description_zh = ?, tdk_description_en = ?,
           tdk_keywords_zh = ?, tdk_keywords_en = ?,
           prompt_template_id = ?, tdk_rule_id = ?, meta = ?
       WHERE id = ?`,
    ).run(
      tdk.titleZh,
      tdk.titleEn,
      tdk.descriptionZh,
      tdk.descriptionEn,
      tdk.keywordsZh,
      tdk.keywordsEn,
      template?.id ?? null,
      rule?.id ?? null,
      JSON.stringify(nextMeta),
      historyId,
    )
  }

  res.json({
    record: getHistoryById(historyId),
    history: getHistory(),
  })
})

app.post('/api/generate/batch', async (req, res) => {
  const payload = z
    .object({
      quantity: z.number().int().min(1).max(50),
      directionPool: z.array(z.string().trim()).min(1),
      productIds: z.array(z.number().int().positive()).default([]),
      exportFormat: z.enum(['md', 'docx']),
    })
    .parse(req.body)

  const products = payload.productIds.length
    ? payload.productIds.map((id) => getProductById(id)).filter(Boolean) as Product[]
    : [null]

  const createdRecords: HistoryRecord[] = []
  for (let index = 0; index < payload.quantity; index += 1) {
    const direction = payload.directionPool[index % payload.directionPool.length]
    const product = products[index % products.length]
    const template = pickPromptTemplate(direction)
    const rule = pickRule(direction, template)
    const titlePrompt = pickTitlePrompt(direction)

    const titles = await generateTitles({
      settings: getSettings(),
      direction,
      titlePrompt,
      keyword: '',
      company: getCompanyProfile(),
      product,
    })

    const selectedTitle = titles[0]
    if (!selectedTitle) {
      throw new Error(`第 ${index + 1} 篇批量生成未拿到标题候选。`)
    }
    const article = await generateArticle({
      settings: getSettings(),
      direction,
      keyword: '',
      outputLanguage: 'zh-en',
      company: getCompanyProfile(),
      product,
      template,
      rule,
      selectedTitle,
    })

    const insert = db
      .prepare(
        `INSERT INTO history (
          direction, product_id, mode, title_options, selected_title_zh, selected_title_en, body_zh, body_en,
          tdk_title_zh, tdk_title_en, tdk_description_zh, tdk_description_en, tdk_keywords_zh, tdk_keywords_en,
          prompt_template_id, tdk_rule_id, meta
        ) VALUES (?, ?, 'brutal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        direction,
        product?.id ?? null,
        JSON.stringify(titles),
        selectedTitle.zh,
        selectedTitle.en,
        article.bodyZh,
        article.bodyEn,
        article.tdk.titleZh,
        article.tdk.titleEn,
        article.tdk.descriptionZh,
        article.tdk.descriptionEn,
        article.tdk.keywordsZh,
        article.tdk.keywordsEn,
        template?.id ?? null,
        rule?.id ?? null,
        JSON.stringify({
          productName: product?.name ?? null,
          batchIndex: index + 1,
          promptName: template?.name ?? null,
          ruleName: rule?.name ?? null,
          outputLanguage: 'zh-en',
        }),
      )

    const historyId = Number(insert.lastInsertRowid)
    const savedPath = await exportHistory(historyId, payload.exportFormat)
    const fieldName = payload.exportFormat === 'md' ? 'export_md_path' : 'export_docx_path'
    db.prepare(`UPDATE history SET ${fieldName} = ? WHERE id = ?`).run(savedPath, historyId)
    createdRecords.push(getHistoryById(historyId))
  }

  res.json({
    records: createdRecords,
    history: getHistory(),
  })
})

app.post('/api/history/:id/export', async (req, res) => {
  const payload = z
    .object({
      format: z.enum(['md', 'docx']),
    })
    .parse(req.body)

  const historyId = Number(req.params.id)
  const savedPath = await exportHistory(historyId, payload.format)
  const fieldName = payload.format === 'md' ? 'export_md_path' : 'export_docx_path'
  db.prepare(`UPDATE history SET ${fieldName} = ? WHERE id = ?`).run(savedPath, historyId)
  res.json({
    record: getHistoryById(historyId),
    savedPath,
    history: getHistory(),
  })
})

app.use('/exports', express.static(EXPORT_DIR))

const DIST_INDEX_PATH = path.join(DIST_DIR, 'index.html')

if (await exists(DIST_INDEX_PATH)) {
  app.use(express.static(DIST_DIR))
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(DIST_INDEX_PATH)
  })
}

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  void next
  const message = error instanceof Error ? error.message : '服务器发生未知错误。'
  res.status(500).json({ error: message })
})

const port = Number(process.env.PORT || 4318)
app.listen(port, () => {
  console.log(`SEO Matrix Studio server running at http://localhost:${port}`)
})

function getBootstrapPayload() {
  return {
    settings: getSettings(),
    titlePrompts: getTitlePrompts(),
    prompts: getPromptTemplates(),
    rules: getTdkRules(),
    company: getCompanyProfile(),
    products: getProducts(),
    history: getHistory(),
    nodeDownloadUrl: NODE_DOWNLOAD_URL,
  }
}

function getTitlePrompts(): TitlePromptTemplate[] {
  const rows = db.prepare(`SELECT * FROM title_prompts ORDER BY updated_at DESC`).all() as Array<
    Record<string, string | number>
  >

  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    direction: String(row.direction),
    prompt: String(row.prompt),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }))
}

function getSettings() {
  const row = db
    .prepare(
      `SELECT api_url, api_key_encrypted, model_name, output_dir, product_split_marker, title_timeout_sec, article_timeout_sec, english_timeout_sec, updated_at
        FROM app_settings WHERE id = 1`,
    )
    .get() as
    | {
        api_url: string
        api_key_encrypted: string
        model_name: string
        output_dir: string
        product_split_marker: string
        title_timeout_sec: number
        article_timeout_sec: number
        english_timeout_sec: number
        updated_at: string
      }
    | undefined

  return {
    apiUrl: row?.api_url ?? '',
    apiKey: row?.api_key_encrypted ? decrypt(row.api_key_encrypted) : '',
    modelName: row?.model_name ?? '',
    outputDir: row?.output_dir ?? DEFAULT_OUTPUT_DIR,
    productSplitMarker: row?.product_split_marker ?? '',
    titleTimeoutSec: Math.max(5, Number(row?.title_timeout_sec ?? 90)),
    articleTimeoutSec: Math.max(5, Number(row?.article_timeout_sec ?? 35)),
    englishTimeoutSec: Math.max(5, Number(row?.english_timeout_sec ?? 25)),
    updatedAt: row?.updated_at ?? '',
  }
}

function getPromptTemplates(): PromptTemplate[] {
  const rows = db
    .prepare(`SELECT * FROM prompt_templates ORDER BY updated_at DESC`)
    .all() as Array<Record<string, string | number | null>>

  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    direction: String(row.direction),
    bodyPrompt: String(row.body_prompt),
    tdkPrompt: String(row.tdk_prompt),
    tdkRuleId: row.tdk_rule_id === null ? null : Number(row.tdk_rule_id),
    includeCompanyProfile: Number(row.include_company_profile ?? 0) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }))
}

function getTdkRules(): TdkRule[] {
  const rows = db.prepare(`SELECT * FROM tdk_rules ORDER BY updated_at DESC`).all() as Array<
    Record<string, string | number>
  >

  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    titleRule: String(row.title_rule),
    descriptionRule: String(row.description_rule),
    keywordsRule: String(row.keywords_rule),
    mustInclude: parseJsonArray(String(row.must_include)),
    forbiddenWords: parseJsonArray(String(row.forbidden_words)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }))
}

function getCompanyProfile() {
  const row = db.prepare(`SELECT * FROM company_profile WHERE id = 1`).get() as
    | Record<string, string | number>
    | undefined

  return {
    sourceName: String(row?.source_name ?? ''),
    rawContent: String(row?.raw_content ?? ''),
    strengths: parseJsonArray(String(row?.strengths ?? '[]')),
    tone: String(row?.tone ?? ''),
    scenarios: parseJsonArray(String(row?.scenarios ?? '[]')),
    updatedAt: String(row?.updated_at ?? ''),
  }
}

function getProducts(): Product[] {
  const rows = db.prepare(`SELECT * FROM products ORDER BY updated_at DESC`).all() as Array<
    Record<string, string | number>
  >

  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    content: String(row.content),
    keywords: parseJsonArray(String(row.keywords)),
    scenarios: parseJsonArray(String(row.scenarios)),
    sourceName: String(row.source_name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }))
}

function getProductById(id: number | null) {
  if (!id) {
    return null
  }

  return getProducts().find((product) => product.id === id) ?? null
}

function getHistory(): HistoryRecord[] {
  const rows = db.prepare(`SELECT * FROM history ORDER BY created_at DESC, id DESC LIMIT 100`).all() as Array<
    Record<string, string | number | null>
  >

  return rows.map(mapHistoryRecord)
}

function getHistoryById(id: number) {
  const row = db.prepare(`SELECT * FROM history WHERE id = ?`).get(id) as
    | Record<string, string | number | null>
    | undefined

  if (!row) {
    throw new Error(`未找到历史记录 ${id}`)
  }

  return mapHistoryRecord(row)
}

function mapHistoryRecord(row: Record<string, string | number | null>): HistoryRecord {
  return {
    id: Number(row.id),
    direction: String(row.direction),
    productId: row.product_id === null ? null : Number(row.product_id),
    mode: String(row.mode) === 'brutal' ? 'brutal' : 'standard',
    titleOptions: safeJson<{ zh: string; en: string; reason: string }[]>(String(row.title_options), []),
    selectedTitleZh: String(row.selected_title_zh),
    selectedTitleEn: String(row.selected_title_en),
    bodyZh: String(row.body_zh),
    bodyEn: String(row.body_en),
    tdkTitleZh: String(row.tdk_title_zh),
    tdkTitleEn: String(row.tdk_title_en),
    tdkDescriptionZh: String(row.tdk_description_zh),
    tdkDescriptionEn: String(row.tdk_description_en),
    tdkKeywordsZh: String(row.tdk_keywords_zh),
    tdkKeywordsEn: String(row.tdk_keywords_en),
    promptTemplateId: row.prompt_template_id === null ? null : Number(row.prompt_template_id),
    tdkRuleId: row.tdk_rule_id === null ? null : Number(row.tdk_rule_id),
    meta: safeJson<JsonRecord>(String(row.meta), {}),
    exportMdPath: row.export_md_path ? String(row.export_md_path) : null,
    exportDocxPath: row.export_docx_path ? String(row.export_docx_path) : null,
    createdAt: String(row.created_at),
  }
}

function pickTitlePrompt(direction: string, titlePromptId?: number | null) {
  const prompts = getTitlePrompts()
  if (titlePromptId) {
    const direct = prompts.find((item) => item.id === titlePromptId)
    if (direct) {
      return direct
    }
  }
  return prompts.find((item) => item.direction === direction) ?? prompts[0] ?? null
}

function pickPromptTemplate(direction: string) {
  const templates = getPromptTemplates()
  return templates.find((item) => item.direction === direction) ?? templates[0] ?? null
}

function pickRule(_direction: string, template?: PromptTemplate | null) {
  const rules = getTdkRules()
  if (template?.tdkRuleId) {
    const boundRule = rules.find((item) => item.id === template.tdkRuleId)
    if (boundRule) {
      return boundRule
    }
  }
  return rules[0] ?? null
}

function parseJsonArray(value: string) {
  return safeJson<string[]>(value, [])
}

function normalizeChineseBodyOutput(value: string) {
  const paragraphs = value
    .split(/\n\s*\n|\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)

  if (!paragraphs.length) {
    return value.trim()
  }

  const filtered = paragraphs.filter((paragraph) => !isEnglishHeavyParagraph(paragraph))
  const next = (filtered.length ? filtered : paragraphs).join('\n\n').trim()
  return next || value.trim()
}

function isEnglishHeavyParagraph(value: string) {
  const asciiLetters = (value.match(/[A-Za-z]/g) ?? []).length
  const englishWords = (value.match(/[A-Za-z]{3,}/g) ?? []).length
  const cjkChars = (value.match(/[\u4e00-\u9fff]/g) ?? []).length

  if (cjkChars >= 16) {
    return false
  }

  return englishWords >= 8 || (asciiLetters >= 45 && cjkChars < 10)
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function ensureSettingColumn(name: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(app_settings)`).all() as Array<{ name: string }>
  if (columns.some((column) => column.name === name)) {
    return
  }
  db.exec(`ALTER TABLE app_settings ADD COLUMN ${name} ${definition}`)
}

function ensureTableColumn(tableName: string, name: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  if (columns.some((column) => column.name === name)) {
    return
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`)
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(UPLOAD_DIR, { recursive: true })
  await fs.mkdir(EXPORT_DIR, { recursive: true })
}

async function exists(target: string) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function getSecretKey() {
  if (!existsSync(KEY_PATH)) {
    writeFileSync(KEY_PATH, randomBytes(32).toString('hex'), 'utf8')
  }

  const hex = readFileSync(KEY_PATH, 'utf8')
  return Buffer.from(hex.trim(), 'hex')
}

function seedDefaults() {
  db.prepare(
    `INSERT OR IGNORE INTO app_settings (id, output_dir) VALUES (1, ?)`,
  ).run(DEFAULT_OUTPUT_DIR)

  db.prepare(
    `INSERT OR IGNORE INTO company_profile (id) VALUES (1)`,
  ).run()

  const promptCount = Number(
    (db.prepare(`SELECT COUNT(*) as count FROM prompt_templates`).get() as { count: number }).count,
  )
  if (promptCount === 0) {
    const seedPrompts = [
      {
        name: '科普型默认',
        direction: '科普',
        bodyPrompt:
          '写一篇中英双语 SEO 文章。中文和英文都要完整成文，结构清晰，段落自然，优先解决用户问题，再自然引入公司与产品价值。',
        tdkPrompt:
          '根据文章内容输出中英双语 TDK，Title 与 Description 符合搜索摘要风格，Keywords 保持简洁。',
        includeCompanyProfile: true,
      },
      {
        name: '产品介绍默认',
        direction: '产品介绍',
        bodyPrompt:
          '写一篇中英双语产品介绍文章，必须把产品特点、核心优势、适用场景、公司能力自然写进去。',
        tdkPrompt:
          '输出与产品介绍文章匹配的中英双语 TDK，Title 要带核心词，Description 要有场景和优势。',
        includeCompanyProfile: true,
      },
      {
        name: '场景推荐默认',
        direction: '场景推荐',
        bodyPrompt:
          '写一篇中英双语场景推荐文章，以场景问题为切口，结合公司与产品给出解决方案。',
        tdkPrompt:
          '根据场景推荐文章输出中英双语 TDK，Title 强调场景词，Description 强调问题与解决方案。',
        includeCompanyProfile: true,
      },
    ]

    for (const item of seedPrompts) {
      db.prepare(
        `INSERT INTO prompt_templates (name, direction, title_prompt, body_prompt, tdk_prompt, include_company_profile)
          VALUES (?, ?, '', ?, ?, ?)`,
      ).run(item.name, item.direction, item.bodyPrompt, item.tdkPrompt, item.includeCompanyProfile ? 1 : 0)
    }
  }

  const titlePromptCount = Number(
    (db.prepare(`SELECT COUNT(*) as count FROM title_prompts`).get() as { count: number }).count,
  )
  if (titlePromptCount === 0) {
    const seedTitlePrompts = [
      {
        name: '科普标题默认',
        direction: '科普',
        prompt: '为目标主题生成 3 组适合 SEO 的中英双语标题。标题要自然、可信、具搜索意图，不要堆砌关键词。',
      },
      {
        name: '产品介绍标题默认',
        direction: '产品介绍',
        prompt: '生成 3 组面向采购或对比搜索意图的中英双语产品介绍标题，要突出卖点和适用场景。',
      },
      {
        name: '场景推荐标题默认',
        direction: '场景推荐',
        prompt: '生成 3 组适合场景推荐、解决方案导向的中英双语标题，突出应用场景和收益。',
      },
    ]

    for (const item of seedTitlePrompts) {
      db.prepare(
        `INSERT INTO title_prompts (name, direction, prompt)
          VALUES (?, ?, ?)`,
      ).run(item.name, item.direction, item.prompt)
    }
  }

  const ruleCount = Number(
    (db.prepare(`SELECT COUNT(*) as count FROM tdk_rules`).get() as { count: number }).count,
  )
  if (ruleCount === 0) {
    const seedRules = [
      {
        name: '科普规则',
        titleRule: '中文 Title 控制在 32 字内，英文 Title 控制在 60 characters 内，优先解决问题导向。',
        descriptionRule: '中文 70 字内，英文 155 characters 内，强调可读性和搜索意图。',
        keywordsRule: '关键词以主题词+场景词为主，不超过 6 组。',
        mustInclude: ['品牌可信度'],
        forbiddenWords: ['最强', '第一'],
      },
      {
        name: '产品介绍规则',
        titleRule: 'Title 必须带核心产品词，中文 30 字内，英文 60 characters 内。',
        descriptionRule: 'Description 强调产品特点、公司能力和适用场景。',
        keywordsRule: '关键词以产品词、规格词、应用词组合，不超过 8 组。',
        mustInclude: ['产品名称'],
        forbiddenWords: ['包治百病'],
      },
      {
        name: '场景推荐规则',
        titleRule: 'Title 体现使用场景和收益，中文 32 字内，英文 60 characters 内。',
        descriptionRule: 'Description 体现用户问题、使用场景、解决方案。',
        keywordsRule: '关键词以场景词+解决方案词为主，不超过 8 组。',
        mustInclude: ['场景词'],
        forbiddenWords: ['100%'],
      },
    ]

    for (const item of seedRules) {
      db.prepare(
        `INSERT INTO tdk_rules (name, direction, title_rule, description_rule, keywords_rule, must_include, forbidden_words)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.name,
        '',
        item.titleRule,
        item.descriptionRule,
        item.keywordsRule,
        JSON.stringify(item.mustInclude),
        JSON.stringify(item.forbiddenWords),
      )
    }
  }
}

function backfillPromptRuleBindings() {
  const prompts = db
    .prepare(`SELECT id, direction, tdk_rule_id FROM prompt_templates`)
    .all() as Array<{ id: number; direction: string; tdk_rule_id: number | null }>

  const rules = getTdkRules()
  const fallbackRule = rules[0]
  for (const prompt of prompts) {
    if (prompt.tdk_rule_id) {
      continue
    }
    const matchedRule = fallbackRule
    if (!matchedRule) {
      continue
    }
    db.prepare(`UPDATE prompt_templates SET tdk_rule_id = ? WHERE id = ?`).run(matchedRule.id, prompt.id)
  }
}

function backfillTitlePromptsFromLegacyPrompts() {
  const titlePromptCount = Number(
    (db.prepare(`SELECT COUNT(*) as count FROM title_prompts`).get() as { count: number }).count,
  )
  if (titlePromptCount > 0) {
    return
  }

  const legacyPrompts = db
    .prepare(`SELECT name, direction, title_prompt FROM prompt_templates WHERE TRIM(title_prompt) <> ''`)
    .all() as Array<{ name: string; direction: string; title_prompt: string }>

  for (const item of legacyPrompts) {
    db.prepare(
      `INSERT INTO title_prompts (name, direction, prompt)
        VALUES (?, ?, ?)`,
    ).run(`${item.name} 标题`, item.direction, item.title_prompt)
  }
}

function buildCompanyInsights(rawContent: string) {
  const lines = rawContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const strengths = lines
    .filter((line) => /优势|特点|经验|服务|quality|advantage|strength/i.test(line))
    .slice(0, 6)

  const scenarios = lines
    .filter((line) => /适用|适合|应用|场景|for|use|scenario/i.test(line))
    .slice(0, 5)

  return {
    strengths: strengths.length ? strengths : lines.slice(0, 4),
    tone: '专业、克制、解决方案导向',
    scenarios: scenarios.length ? scenarios : lines.slice(4, 8),
  }
}

function buildProductInsights(rawContent: string) {
  const segments = rawContent
    .split(/[\n,，;；]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)

  const modelMatches = Array.from(
    new Set(
      Array.from(rawContent.matchAll(/\b[A-Z]{1,4}\d{1,6}(?:[-/][A-Z0-9]{1,8})?\b/g)).map((match) => match[0]),
    ),
  ).slice(0, 6)

  return {
    keywords: modelMatches.length ? modelMatches : segments.slice(0, 6),
    scenarios: segments.slice(6, 10),
  }
}

async function extractDocumentText(filePath: string, originalName: string) {
  const ext = path.extname(originalName).toLowerCase()

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value.trim()
  }

  if (ext === '.pdf') {
    const buffer = await fs.readFile(filePath)
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    await parser.destroy()
    return result.text.trim()
  }

  if (ext === '.txt' || ext === '.md') {
    return (await fs.readFile(filePath, 'utf8')).trim()
  }

  throw new Error(`暂不支持的文件类型：${ext || '未知类型'}`)
}

function normalizeEndpoint(apiUrl: string) {
  const trimmed = apiUrl.trim().replace(/\/$/, '')
  if (trimmed.endsWith('/chat/completions') || trimmed.endsWith('/responses')) {
    return trimmed
  }
  return `${trimmed}/chat/completions`
}

async function llmRequest({
  settings,
  prompt,
  timeoutMs = 30000,
  responseFormat,
  maxTokens,
}: {
  settings: ReturnType<typeof getSettings>
  prompt: string
  timeoutMs?: number
  responseFormat?: 'json_object'
  maxTokens?: number
}) {
  const endpoint = normalizeEndpoint(settings.apiUrl)
  const useResponses = endpoint.endsWith('/responses')

  const body = useResponses
    ? {
        model: settings.modelName,
        input: prompt,
      }
    : {
        model: settings.modelName,
        stream: false,
        temperature: responseFormat ? 0.2 : 0.8,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(responseFormat
          ? {
              response_format: {
                type: responseFormat,
              },
            }
          : {}),
        messages: [
          {
            role: 'system',
            content:
              '你是 SEO 内容策略助手。严格遵循要求输出，不写多余前后缀。除非要求解释，否则只输出 JSON。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.toLowerCase().includes('timeout') || message.toLowerCase().includes('aborted')) {
      throw new Error(`LLM 生成超时（>${Math.ceil(timeoutMs / 1000)} 秒）`)
    }
    throw error
  }

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`LLM 请求失败：${response.status} ${detail}`)
  }

  const payload = (await response.json()) as JsonRecord
  if (useResponses) {
    const text = payload.output_text
    if (typeof text === 'string' && text.trim()) {
      return text.trim()
    }
  }

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
  const content = choice?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    const merged = content
      .map((item) => ('text' in item && typeof item.text === 'string' ? item.text : ''))
      .join('\n')
      .trim()
    if (merged) {
      return merged
    }
  }

  throw new Error('LLM 返回内容无法解析。')
}

function extractJsonBlock(text: string) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced) {
    return fenced[1].trim()
  }

  const objectMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (objectMatch) {
    return objectMatch[1]
  }

  return text
}

function extractTaggedBlock(text: string, tag: string) {
  const pattern = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'i')
  const match = text.match(pattern)
  return match?.[1]?.trim() || ''
}

async function generateTitles({
  settings,
  direction,
  titlePrompt,
  keyword,
  company,
  product,
}: {
  settings: ReturnType<typeof getSettings>
  direction: string
  titlePrompt: TitlePromptTemplate | null
  keyword: string
  company: ReturnType<typeof getCompanyProfile>
  product: Product | null
}) {
  const prompt = `
你现在要为一个 SEO 工作流生成标题候选。

文案方向：${direction}
关键词：${keyword || '未指定'}
标题指令：${titlePrompt?.prompt || '生成 SEO 友好的中英双语标题'}

公司资料：
- 优势：${company.strengths.join(' / ') || '暂无'}
- 语气：${company.tone || '专业'}
- 场景：${company.scenarios.join(' / ') || '暂无'}

产品资料：
- 产品名：${product?.name || '未指定'}
- 内容：${product?.content || '未指定'}
- 关键词：${product?.keywords.join(' / ') || '暂无'}

请只输出严格 JSON 数组，长度为 3，每项格式如下：
[
  { "zh": "中文标题", "en": "English title", "reason": "简短理由" }
]
`

  const raw = await llmRequest({ settings, prompt, timeoutMs: settings.titleTimeoutSec * 1000, maxTokens: 900 })
  return safeJson<{ zh: string; en: string; reason: string }[]>(
    extractJsonBlock(raw),
    [],
  )
}

async function extractCompanyProfileFromDocument({
  settings,
  rawContent,
  sourceName,
}: {
  settings: ReturnType<typeof getSettings>
  rawContent: string
  sourceName: string
}) {
  if (!settings.apiUrl || !settings.apiKey || !settings.modelName) {
    return null
  }

  const prompt = `
你现在要从一份公司资料中提炼结构化信息。文档格式可能很乱，不要依赖固定标题。

请提取：
1. strengths: 公司优势，3-6条
2. tone: 品牌语气，一句话
3. scenarios: 适用场景，2-5条

来源文件：${sourceName}

文档内容：
${rawContent.slice(0, 12000)}

只输出严格 JSON：
{
  "strengths": ["优势1", "优势2"],
  "tone": "专业、可靠、解决方案导向",
  "scenarios": ["场景1", "场景2"]
}
`

  try {
    const raw = await llmRequest({ settings, prompt, timeoutMs: 45000, responseFormat: 'json_object' })
    const parsed = safeJson<{
      strengths?: string[]
      tone?: string
      scenarios?: string[]
    }>(extractJsonBlock(raw), {})

    if (!parsed.strengths?.length && !parsed.tone && !parsed.scenarios?.length) {
      return null
    }

    return {
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.filter(Boolean).slice(0, 6) : [],
      tone: parsed.tone?.trim() || '专业、克制、解决方案导向',
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios.filter(Boolean).slice(0, 5) : [],
    }
  } catch {
    return null
  }
}

function splitProductsFromDocument({
  rawContent,
  fallbackName,
  sourceName,
  splitMarker,
}: {
  rawContent: string
  fallbackName: string
  sourceName: string
  splitMarker: string
}): { items: ProductDraft[]; reason?: string } {
  const marker = splitMarker.trim()
  const chunks = marker
    ? rawContent
        .split(marker)
        .map((item) => item.trim())
        .filter(Boolean)
    : [rawContent.trim()].filter(Boolean)

  const items = chunks.map((chunk, index) => {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const titleLine = lines[0] || ''
    const insights = buildProductInsights(chunk)

    return {
      name: titleLine.slice(0, 80) || `${fallbackName}-${index + 1}`,
      content: chunk,
      keywords: insights.keywords,
      scenarios: insights.scenarios,
      sourceName,
    }
  })

  if (!marker) {
    return {
      items,
      reason: '未填写分割标记，系统按整份文档导入为单一产品候选。',
    }
  }

  if (chunks.length <= 1) {
    return {
      items,
      reason: `已设置分割标记“${marker}”，但文档中未匹配到多个区块，因此仍按单一产品候选导入。`,
    }
  }

  return {
    items,
    reason: `已按分割标记“${marker}”切分出 ${chunks.length} 个产品候选。`,
  }
}

async function generateArticle({
  settings,
  direction,
  keyword,
  outputLanguage,
  company,
  product,
  template,
  rule,
  selectedTitle,
}: {
  settings: ReturnType<typeof getSettings>
  direction: string
  keyword: string
  outputLanguage: OutputLanguage
  company: ReturnType<typeof getCompanyProfile>
  product: Product | null
  template: PromptTemplate | null
  rule: TdkRule | null
  selectedTitle: { zh: string; en: string }
}) {
  const articlePackageZh = await generateArticleBody({
    settings,
    direction,
    keyword,
    outputLanguage,
    company,
    product,
    template,
    rule,
    selectedTitle,
  })

  if (outputLanguage === 'zh') {
    return {
      bodyZh: articlePackageZh.bodyZh,
      bodyEn: '',
      tdk: {
        titleZh: articlePackageZh.tdkTitleZh,
        titleEn: '',
        descriptionZh: articlePackageZh.tdkDescriptionZh,
        descriptionEn: '',
        keywordsZh: articlePackageZh.tdkKeywordsZh,
        keywordsEn: '',
      },
    }
  }

  const translatedPackage = await translateArticleBodyToEnglish({
    settings,
    direction,
    keyword,
    selectedTitle,
    bodyZh: articlePackageZh.bodyZh,
    tdkTitleZh: articlePackageZh.tdkTitleZh,
    tdkDescriptionZh: articlePackageZh.tdkDescriptionZh,
    tdkKeywordsZh: articlePackageZh.tdkKeywordsZh,
  })

  return {
    bodyZh: articlePackageZh.bodyZh,
    bodyEn: translatedPackage.bodyEn,
    tdk: {
      titleZh: outputLanguage === 'en' ? '' : articlePackageZh.tdkTitleZh,
      titleEn: translatedPackage.tdkTitleEn,
      descriptionZh: outputLanguage === 'en' ? '' : articlePackageZh.tdkDescriptionZh,
      descriptionEn: translatedPackage.tdkDescriptionEn,
      keywordsZh: outputLanguage === 'en' ? '' : articlePackageZh.tdkKeywordsZh,
      keywordsEn: translatedPackage.tdkKeywordsEn,
    },
  }
}

async function generateTdkForExistingBody({
  settings,
  direction,
  keyword,
  outputLanguage,
  selectedTitle,
  bodyZh,
  bodyEn,
  template,
  rule,
}: {
  settings: ReturnType<typeof getSettings>
  direction: string
  keyword: string
  outputLanguage: OutputLanguage
  selectedTitle: { zh: string; en: string }
  bodyZh: string
  bodyEn: string
  template: PromptTemplate | null
  rule: TdkRule | null
}) {
  const zhTdk =
    outputLanguage !== 'en'
      ? await generateChineseTdk({
          settings,
          direction,
          keyword,
          selectedTitle,
          bodyZh,
          template,
          rule,
        })
      : {
          titleZh: '',
          descriptionZh: '',
          keywordsZh: '',
        }

  const enTdk =
    outputLanguage !== 'zh'
      ? await generateEnglishTdk({
          settings,
          direction,
          keyword,
          selectedTitle,
          bodyZh,
          bodyEn,
          zhTdk,
        })
      : {
          titleEn: '',
          descriptionEn: '',
          keywordsEn: '',
        }

  return {
    titleZh: zhTdk.titleZh,
    titleEn: enTdk.titleEn,
    descriptionZh: zhTdk.descriptionZh,
    descriptionEn: enTdk.descriptionEn,
    keywordsZh: zhTdk.keywordsZh,
    keywordsEn: enTdk.keywordsEn,
  }
}

async function generateChineseTdk({
  settings,
  direction,
  keyword,
  selectedTitle,
  bodyZh,
  template,
  rule,
}: {
  settings: ReturnType<typeof getSettings>
  direction: string
  keyword: string
  selectedTitle: { zh: string; en: string }
  bodyZh: string
  template: PromptTemplate | null
  rule: TdkRule | null
}) {
  const prompt = `
你现在只负责根据现有中文正文与标题生成中文 TDK，不要重写正文，不要输出英文，不要输出解释。

文案方向：${direction}
关键词：${keyword || '未指定'}
已选中文标题：${selectedTitle.zh}

中文正文：
${bodyZh}

TDK要求：
${template?.tdkPrompt || '输出中文 TDK'}

TDK规则：
- Title：${rule?.titleRule || 'Title 保持精炼'}
- Description：${rule?.descriptionRule || 'Description 简洁准确'}
- Keywords：${rule?.keywordsRule || 'Keywords 自然精炼'}
- 必带词：${rule?.mustInclude.join(' / ') || '无'}
- 禁用词：${rule?.forbiddenWords.join(' / ') || '无'}

请严格按以下标签输出，不要输出其他说明：
[TDK_TITLE_ZH]
中文Title
[/TDK_TITLE_ZH]
[TDK_DESCRIPTION_ZH]
中文Description
[/TDK_DESCRIPTION_ZH]
[TDK_KEYWORDS_ZH]
中文关键词，逗号分隔
[/TDK_KEYWORDS_ZH]
`

  const raw = await llmRequest({
    settings,
    prompt,
    timeoutMs: settings.articleTimeoutSec * 1000,
    maxTokens: 420,
  })

  const titleZh = extractTaggedBlock(raw, 'TDK_TITLE_ZH')
  const descriptionZh = extractTaggedBlock(raw, 'TDK_DESCRIPTION_ZH')
  const keywordsZh = extractTaggedBlock(raw, 'TDK_KEYWORDS_ZH')

  if (!titleZh || !descriptionZh) {
    throw new Error('TDK 生成失败：模型返回内容未能解析为有效的中文 TDK。')
  }

  return {
    titleZh,
    descriptionZh,
    keywordsZh,
  }
}

async function generateArticleBody({
  settings,
  direction,
  keyword,
  outputLanguage,
  company,
  product,
  template,
  rule,
  selectedTitle,
}: {
  settings: ReturnType<typeof getSettings>
  direction: string
  keyword: string
  outputLanguage: OutputLanguage
  company: ReturnType<typeof getCompanyProfile>
  product: Product | null
  template: PromptTemplate | null
  rule: TdkRule | null
  selectedTitle: { zh: string; en: string }
}) {
  const companyRawExcerpt = company.rawContent.replace(/\s+/g, ' ').slice(0, 360)
  const bodyInstructions = template?.includeCompanyProfile
    ? `${template?.bodyPrompt || '写完整的 SEO 正文'}

生成的文章中要用自然得语气穿插介绍公司的优势内容，公司介绍如下：${companyRawExcerpt || '暂无原始公司资料'}`
    : template?.bodyPrompt || '写完整的 SEO 正文'
  const companyContext = template?.includeCompanyProfile
    ? `
公司资料：
- 优势：${company.strengths.join(' / ') || '暂无'}
- 语气：${company.tone || '专业'}
- 场景：${company.scenarios.join(' / ') || '暂无'}
`
    : ''

  const prompt = `
你现在只负责输出中文 SEO 正文与中文 TDK，不要输出英文，不要输出解释。
注意：即使下方模板提到“双语”“中英”“英文”或“翻译”，本阶段也一律忽略；本阶段只能输出中文。
注意：如果公司资料或产品资料里出现英文内容，你必须先理解后改写成中文，不能把英文原句直接写进 [BODY_ZH]。
注意：[BODY_ZH] 里不能出现完整英文段落，不能把中文段落和英文段落混排。

文案方向：${direction}
关键词：${keyword || '未指定'}
已选中文标题：${selectedTitle.zh}

正文要求：
${bodyInstructions}

输出语言：${outputLanguage === 'en' ? '仅英文，先产出中文底稿再翻译为英文' : outputLanguage === 'zh-en' ? '中英双语，当前这一步只产出中文底稿' : '仅中文'}

长度控制：
- 中文正文控制在 300-420 个中文字符之间
- 分 3-4 段
- 每段都必须以中文为主，不得出现连续 8 个以上英文单词
- 不要输出推理过程、注释或额外说明

${companyContext}

产品资料：
- 产品名：${product?.name || '未指定'}
- 产品内容：${product?.content.slice(0, 360) || '未指定'}
- 产品关键词：${product?.keywords.join(' / ') || '暂无'}
- 产品场景：${product?.scenarios.join(' / ') || '暂无'}

TDK要求：
${template?.tdkPrompt || '输出中文 TDK'}

TDK规则：
- Title：${rule?.titleRule || 'Title 保持精炼'}
- Description：${rule?.descriptionRule || 'Description 简洁准确'}
- Keywords：${rule?.keywordsRule || 'Keywords 自然精炼'}
- 必带词：${rule?.mustInclude.join(' / ') || '无'}
- 禁用词：${rule?.forbiddenWords.join(' / ') || '无'}

请严格按以下标签输出，不要输出其他说明：
[BODY_ZH]
中文正文，使用换行分段
[/BODY_ZH]
[TDK_TITLE_ZH]
中文Title
[/TDK_TITLE_ZH]
[TDK_DESCRIPTION_ZH]
中文Description
[/TDK_DESCRIPTION_ZH]
[TDK_KEYWORDS_ZH]
中文关键词，逗号分隔
[/TDK_KEYWORDS_ZH]
`

  const raw = await llmRequest({
    settings,
    prompt,
    timeoutMs: settings.articleTimeoutSec * 1000,
    maxTokens: 900,
  })
  const rawBodyZh = extractTaggedBlock(raw, 'BODY_ZH')
  const bodyZh = rawBodyZh ? normalizeChineseBodyOutput(rawBodyZh) : ''
  const tdkTitleZh = extractTaggedBlock(raw, 'TDK_TITLE_ZH')
  const tdkDescriptionZh = extractTaggedBlock(raw, 'TDK_DESCRIPTION_ZH')
  const tdkKeywordsZh = extractTaggedBlock(raw, 'TDK_KEYWORDS_ZH')

  if (!bodyZh) {
    throw new Error('正文生成失败：模型返回内容未能解析为有效的中文正文。')
  }

  if (!tdkTitleZh || !tdkDescriptionZh) {
    throw new Error('TDK 生成失败：模型返回内容未能解析为有效的中文 TDK。')
  }

  return {
    bodyZh,
    tdkTitleZh,
    tdkDescriptionZh,
    tdkKeywordsZh,
  }
}

async function translateArticleBodyToEnglish({
  settings,
  direction,
  keyword,
  selectedTitle,
  bodyZh,
  tdkTitleZh,
  tdkDescriptionZh,
  tdkKeywordsZh,
}: {
  settings: ReturnType<typeof getSettings>
  direction: string
  keyword: string
  selectedTitle: { zh: string; en: string }
  bodyZh: string
  tdkTitleZh: string
  tdkDescriptionZh: string
  tdkKeywordsZh: string
}) {
  const prompt = `
你现在只负责把中文 SEO 正文和中文 TDK 转成自然、专业、可读的英文，不要输出中文，不要输出解释。

文案方向：${direction}
关键词：${keyword || '未指定'}
标题参考：
- 中文：${selectedTitle.zh}
- 英文：${selectedTitle.en}

翻译要求：
- 保持原文结构和段落数量
- 用自然英文改写，不要逐字硬翻
- 保留 SEO 可读性和专业语气
- 英文正文控制在 220-320 个单词之间
- 英文 TDK 要自然，不要直接照搬中文语序

中文正文：
${bodyZh}

中文 TDK：
- Title：${tdkTitleZh}
- Description：${tdkDescriptionZh}
- Keywords：${tdkKeywordsZh || '无'}

请严格按以下标签输出，不要输出其他说明：
[BODY_EN]
English body with paragraph breaks
[/BODY_EN]
[TDK_TITLE_EN]
English Title
[/TDK_TITLE_EN]
[TDK_DESCRIPTION_EN]
English Description
[/TDK_DESCRIPTION_EN]
[TDK_KEYWORDS_EN]
English keywords, comma separated
[/TDK_KEYWORDS_EN]
`

  const raw = await llmRequest({
    settings,
    prompt,
    timeoutMs: settings.englishTimeoutSec * 1000,
    maxTokens: 700,
  })
  const bodyEn = extractTaggedBlock(raw, 'BODY_EN')
  const tdkTitleEn = extractTaggedBlock(raw, 'TDK_TITLE_EN')
  const tdkDescriptionEn = extractTaggedBlock(raw, 'TDK_DESCRIPTION_EN')
  const tdkKeywordsEn = extractTaggedBlock(raw, 'TDK_KEYWORDS_EN')

  if (!bodyEn) {
    throw new Error('英文翻译失败：模型返回内容未能解析为有效的英文正文。')
  }
  if (!tdkTitleEn || !tdkDescriptionEn) {
    throw new Error('英文 TDK 生成失败：模型返回内容未能解析为有效的英文 TDK。')
  }
  return {
    bodyEn,
    tdkTitleEn,
    tdkDescriptionEn,
    tdkKeywordsEn,
  }
}

async function generateEnglishTdk({
  settings,
  direction,
  keyword,
  selectedTitle,
  bodyZh,
  bodyEn,
  zhTdk,
}: {
  settings: ReturnType<typeof getSettings>
  direction: string
  keyword: string
  selectedTitle: { zh: string; en: string }
  bodyZh: string
  bodyEn: string
  zhTdk: { titleZh: string; descriptionZh: string; keywordsZh: string }
}) {
  const prompt = `
You only need to generate English TDK from the existing article body and title. Do not rewrite the body. Do not output Chinese. Do not add explanations.

Direction: ${direction}
Keyword: ${keyword || 'Not specified'}
Selected title:
- Chinese: ${selectedTitle.zh}
- English: ${selectedTitle.en}

English body:
${bodyEn || 'No English body available.'}

Chinese body reference:
${bodyZh}

Chinese TDK reference:
- Title: ${zhTdk.titleZh || 'N/A'}
- Description: ${zhTdk.descriptionZh || 'N/A'}
- Keywords: ${zhTdk.keywordsZh || 'N/A'}

Requirements:
- Keep it natural, professional, and SEO-readable
- Title and Description must match the article intent
- Keywords should stay concise and comma-separated

Return only these tags:
[TDK_TITLE_EN]
English Title
[/TDK_TITLE_EN]
[TDK_DESCRIPTION_EN]
English Description
[/TDK_DESCRIPTION_EN]
[TDK_KEYWORDS_EN]
English keywords, comma separated
[/TDK_KEYWORDS_EN]
`

  const raw = await llmRequest({
    settings,
    prompt,
    timeoutMs: settings.englishTimeoutSec * 1000,
    maxTokens: 320,
  })

  const titleEn = extractTaggedBlock(raw, 'TDK_TITLE_EN')
  const descriptionEn = extractTaggedBlock(raw, 'TDK_DESCRIPTION_EN')
  const keywordsEn = extractTaggedBlock(raw, 'TDK_KEYWORDS_EN')

  if (!titleEn || !descriptionEn) {
    throw new Error('英文 TDK 生成失败：模型返回内容未能解析为有效的英文 TDK。')
  }

  return {
    titleEn,
    descriptionEn,
    keywordsEn,
  }
}

async function exportHistory(historyId: number, format: 'md' | 'docx') {
  const record = getHistoryById(historyId)
  const outputLanguage = resolveOutputLanguage(record.meta.outputLanguage)
  const settings = getSettings()
  const outputDir = settings.outputDir || DEFAULT_OUTPUT_DIR
  await fs.mkdir(outputDir, { recursive: true })

  const safeName = `${record.createdAt.replace(/[^\d]/g, '').slice(0, 14)}_${sanitizeFileName(
    record.direction,
  )}_${sanitizeFileName(record.selectedTitleZh || 'seo-article')}`
  const outputPath = path.join(outputDir, `${safeName}.${format}`)

  if (format === 'md') {
    const markdown = renderMarkdown(record)
    await fs.writeFile(outputPath, markdown, 'utf8')
    return outputPath
  }
  await exportDocxWithPython(record, outputLanguage, outputPath)
  return outputPath
}

function renderMarkdown(record: HistoryRecord) {
  const outputLanguage = resolveOutputLanguage(record.meta.outputLanguage)
  const sections = [`# ${outputLanguage === 'en' ? record.selectedTitleEn : record.selectedTitleZh}`]

  if (outputLanguage === 'zh-en') {
    sections.push(record.selectedTitleEn)
  }

  if (outputLanguage !== 'en') {
    sections.push(`## 中文正文\n\n${record.bodyZh}`)
  }

  if (outputLanguage !== 'zh') {
    sections.push(`## English Body\n\n${record.bodyEn}`)
  }

  const tdkLines = ['## TDK']
  if (outputLanguage !== 'en') {
    tdkLines.push(`- Title (ZH): ${record.tdkTitleZh}`)
    tdkLines.push(`- Description (ZH): ${record.tdkDescriptionZh}`)
    tdkLines.push(`- Keywords (ZH): ${record.tdkKeywordsZh}`)
  }
  if (outputLanguage !== 'zh') {
    tdkLines.push(`- Title (EN): ${record.tdkTitleEn}`)
    tdkLines.push(`- Description (EN): ${record.tdkDescriptionEn}`)
    tdkLines.push(`- Keywords (EN): ${record.tdkKeywordsEn}`)
  }
  sections.push(tdkLines.join('\n'))

  return `${sections.join('\n\n')}\n`
}

function resolveOutputLanguage(value: unknown): OutputLanguage {
  return value === 'zh' || value === 'en' || value === 'zh-en' ? value : 'zh-en'
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 48)
}

async function exportDocxWithPython(record: HistoryRecord, outputLanguage: OutputLanguage, outputPath: string) {
  if (!existsSync(PYTHON_BIN)) {
    throw new Error('DOCX 导出环境缺失：找不到 .venv/bin/python，请先重新启动工具完成依赖初始化。')
  }

  await fs.mkdir(TMP_DOC_DIR, { recursive: true })
  const payloadPath = path.join(TMP_DOC_DIR, `export-${record.id}-${Date.now()}.json`)
  const payload = {
    outputLanguage,
    selectedTitleZh: record.selectedTitleZh,
    selectedTitleEn: record.selectedTitleEn,
    bodyZh: record.bodyZh,
    bodyEn: record.bodyEn,
    tdkTitleZh: record.tdkTitleZh,
    tdkTitleEn: record.tdkTitleEn,
    tdkDescriptionZh: record.tdkDescriptionZh,
    tdkDescriptionEn: record.tdkDescriptionEn,
    tdkKeywordsZh: record.tdkKeywordsZh,
    tdkKeywordsEn: record.tdkKeywordsEn,
  }

  await fs.writeFile(payloadPath, JSON.stringify(payload), 'utf8')

  try {
    await execFileAsync(PYTHON_BIN, [DOCX_EXPORT_SCRIPT, payloadPath, outputPath], {
      cwd: ROOT_DIR,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    throw new Error(`DOCX 导出失败：${message}`)
  } finally {
    await fs.unlink(payloadPath).catch(() => undefined)
  }
}

function resolveProductSplitMarker(body: Record<string, unknown>) {
  const runtimeMarker = typeof body.productSplitMarker === 'string' ? body.productSplitMarker.trim() : ''
  if (runtimeMarker) {
    return runtimeMarker
  }
  return getSettings().productSplitMarker
}

function normalizeUploadName(value: string) {
  const trimmed = value.trim()
  const decoded = Buffer.from(trimmed, 'latin1').toString('utf8')
  const mojibakePattern = /[ÃÂÅÆÇÐÑØÞßåæçðñø]/i
  const hasCjk = /[\u3400-\u9fff]/.test(decoded)
  if (mojibakePattern.test(trimmed) && (hasCjk || !mojibakePattern.test(decoded))) {
    return decoded
  }
  return trimmed
}

async function chooseDirectoryWithSystemDialog() {
  const platform = process.platform

  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "选择 SEO 输出保存资料夹")',
      ])
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  if (platform === 'win32') {
    try {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$dialog.Description = "选择 SEO 输出保存资料夹"',
        '$dialog.ShowNewFolderButton = $true',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  Write-Output $dialog.SelectedPath',
        '}',
      ].join('; ')
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script])
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  try {
    const { stdout } = await execFileAsync('zenity', [
      '--file-selection',
      '--directory',
      '--title=选择 SEO 输出保存资料夹',
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function openPathInSystem(targetPath: string) {
  const normalized = path.resolve(targetPath)
  const targetDir = path.extname(normalized) ? path.dirname(normalized) : normalized

  if (process.platform === 'darwin') {
    await execFileAsync('open', [targetDir])
    return
  }

  if (process.platform === 'win32') {
    await execFileAsync('explorer', [targetDir])
    return
  }

  await execFileAsync('xdg-open', [targetDir])
}

function encrypt(value: string) {
  if (!value) {
    return ''
  }
  const iv = randomBytes(12)
  const key = getSecretKey()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.')
}

function decrypt(value: string) {
  if (!value) {
    return ''
  }
  const [ivText, tagText, encryptedText] = value.split('.')
  if (!ivText || !tagText || !encryptedText) {
    return ''
  }
  try {
    const key = getSecretKey()
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivText, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(tagText, 'base64'))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64')),
      decipher.final(),
    ])
    return decrypted.toString('utf8')
  } catch {
    return ''
  }
}
