export type OutputLanguage = 'zh' | 'en'

export type Settings = {
  apiUrl: string
  apiKey: string
  modelName: string
  outputDir: string
  productSplitMarker: string
  titleTimeoutSec: number
  articleTimeoutSec: number
  englishTimeoutSec: number
  updatedAt: string
}

export type TitlePromptTemplate = {
  id: number
  name: string
  direction: string
  prompt: string
  createdAt: string
  updatedAt: string
}

export type PromptTemplate = {
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

export type TdkRule = {
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

export type CompanyProfile = {
  sourceName: string
  rawContent: string
  strengths: string[]
  tone: string
  scenarios: string[]
  updatedAt: string
}

export type Product = {
  id: number
  name: string
  content: string
  keywords: string[]
  scenarios: string[]
  sourceName: string
  createdAt: string
  updatedAt: string
}

export type ProductDraft = {
  name: string
  content: string
  keywords: string[]
  scenarios: string[]
  sourceName: string
}

export type TitleOption = {
  zh: string
  en: string
  reason: string
}

export type HistoryRecord = {
  id: number
  direction: string
  productId: number | null
  mode: 'standard' | 'brutal'
  titleOptions: TitleOption[]
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
  meta: Record<string, unknown> & {
    outputLanguage?: OutputLanguage
  }
  exportMdPath: string | null
  exportDocxPath: string | null
  createdAt: string
}

export type BootstrapPayload = {
  settings: Settings
  titlePrompts: TitlePromptTemplate[]
  prompts: PromptTemplate[]
  rules: TdkRule[]
  company: CompanyProfile
  products: Product[]
  history: HistoryRecord[]
  nodeDownloadUrl: string
}
