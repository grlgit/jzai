import { Injectable, Logger } from '@nestjs/common';

export interface HarApiEntry {
  index: number;
  method: string;
  url: string;
  path: string;
  requestContentType: string;
  requestBody: any;
  requestBodyRaw: string;
  responseStatus: number;
  responseBody: any;
  responseBodyRaw: string;
  timestamp: string;
}

export interface WorkflowStep {
  id: string;
  label: string;
  role: 'login' | 'lookup' | 'create' | 'submit' | 'auxiliary';
  api: HarApiEntry;
  dependsOn: string[];
  outputFields: string[];
  inputMappings: Array<{ field: string; fromStep: string; fromField: string }>;
  isConditional: boolean;
  conditionDescription?: string;
}

export interface WorkflowParameter {
  name: string;
  source: string;
  description: string;
  required: boolean;
  type: string;
  sampleValue?: any;
}

export interface AnalyzedWorkflow {
  baseUrl: string;
  steps: WorkflowStep[];
  loginStep?: WorkflowStep;
  submitStep?: WorkflowStep;
  parameters: WorkflowParameter[];
  rawApiCount: number;
  filteredApiCount: number;
}

@Injectable()
export class HarAnalyzerService {
  private readonly logger = new Logger(HarAnalyzerService.name);

  analyze(harJson: any): AnalyzedWorkflow {
    const entries = harJson?.log?.entries || [];
    this.logger.log(`HAR has ${entries.length} entries`);

    // Step 1: Parse & filter
    const apis = this.parseEntries(entries);
    this.logger.log(`Filtered to ${apis.length} business API calls`);

    // Step 2: Identify login
    const loginIdx = apis.findIndex(a =>
      a.method === 'POST' && /login|auth|signin/i.test(a.url),
    );
    const loginApi = loginIdx >= 0 ? apis[loginIdx] : undefined;

    // Step 3: Classify roles
    const steps = this.classifySteps(apis, loginIdx);
    this.logger.log(`Classified ${steps.length} workflow steps`);

    // Step 4: Build dependency graph
    this.buildDependencies(steps);

    // Step 5: Detect conditional patterns
    this.detectConditionals(steps);

    // Step 6: Prune auxiliary steps with no dependents
    const prunedSteps = this.pruneSteps(steps);
    this.logger.log(`After pruning: ${prunedSteps.length} steps`);

    // Step 7: Extract parameters from submit step
    const submitStep = [...prunedSteps].reverse().find(s => s.role === 'submit');
    const parameters = submitStep ? this.extractParameters(submitStep) : [];

    // Determine base URL
    let baseUrl = '';
    if (apis.length > 0) {
      try {
        const u = new URL(apis[0].url);
        baseUrl = `${u.protocol}//${u.host}`;
      } catch {}
    }

    return {
      baseUrl,
      steps: prunedSteps,
      loginStep: prunedSteps.find(s => s.role === 'login'),
      submitStep,
      parameters,
      rawApiCount: entries.length,
      filteredApiCount: apis.length,
    };
  }

  private parseEntries(entries: any[]): HarApiEntry[] {
    const apis: HarApiEntry[] = [];
    const skipExts = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)(\?|$)/i;
    const skipTypes = new Set(['image', 'stylesheet', 'font', 'script']);

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const req = e.request;
      const resp = e.response;
      const url: string = req.url;
      const method: string = req.method;

      // Skip non-POST (most business APIs are POST in ExtJS)
      if (method !== 'POST') continue;
      // Skip static resources
      if (skipExts.test(url)) continue;
      if (skipTypes.has(e._resourceType)) continue;

      const bodyRaw = req.postData?.text || '';
      const respRaw = resp.content?.text || '';

      apis.push({
        index: i,
        method,
        url,
        path: this.extractPath(url),
        requestContentType: req.postData?.mimeType || '',
        requestBody: this.parseBody(bodyRaw),
        requestBodyRaw: bodyRaw,
        responseStatus: resp.status,
        responseBody: this.parseResponseBody(respRaw),
        responseBodyRaw: respRaw.substring(0, 5000),
        timestamp: e.startedDateTime || '',
      });
    }

    return apis;
  }

  private parseBody(raw: string): any {
    if (!raw) return {};
    // Try JSON first
    try { return JSON.parse(raw); } catch {}
    // Try form-urlencoded with embedded JSON
    const result: Record<string, any> = {};
    const params = raw.split('&');
    for (const param of params) {
      const eqIdx = param.indexOf('=');
      if (eqIdx < 0) continue;
      const key = decodeURIComponent(param.substring(0, eqIdx));
      const val = decodeURIComponent(param.substring(eqIdx + 1));
      try { result[key] = JSON.parse(val); } catch { result[key] = val; }
    }
    return result;
  }

  private parseResponseBody(raw: string): any {
    if (!raw) return null;
    const trimmed = raw.trim();
    // Try standard JSON
    try { return JSON.parse(trimmed); } catch {}
    // Try fixing non-standard JSON (single quotes, unquoted keys)
    try {
      const fixed = trimmed
        .replace(/'/g, '"')
        .replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":')
        .replace(/:(\w+)([,}])/g, (_, v, sep) => {
          if (v === 'true' || v === 'false' || v === 'null' || /^\d+$/.test(v)) return `:${v}${sep}`;
          return `:"${v}"${sep}`;
        });
      return JSON.parse(fixed);
    } catch {}
    return trimmed.substring(0, 1000);
  }

  private extractPath(url: string): string {
    try { return new URL(url).pathname; } catch { return url; }
  }

  private classifySteps(apis: HarApiEntry[], loginIdx: number): WorkflowStep[] {
    const steps: WorkflowStep[] = [];
    const seen = new Set<string>();

    // Skip patterns — UI framework noise
    const noisePatterns = /catCodes|readLayout|toJson|typestop|types4lot|webView|panelTree|userDataFilter|listStyleImgLib/i;

    for (let i = 0; i < apis.length; i++) {
      const api = apis[i];
      const path = api.path.toLowerCase();

      // Skip noise
      if (noisePatterns.test(api.url)) continue;

      // Deduplicate: same URL + similar body = same step (keep first and last)
      const bodyKey = JSON.stringify(api.requestBody).substring(0, 100);
      const dedupKey = `${api.url}|${bodyKey}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      let role: WorkflowStep['role'] = 'auxiliary';
      let label = api.path.replace(/^.*\//, '').replace(/\.do.*$/, '');

      if (i === loginIdx) {
        role = 'login';
        label = '登录';
      } else if (/save|create|insert|add|checkIn/i.test(path)) {
        role = 'create';
        label = this.guessLabel(api, '创建');
      } else if (/list|query|search|get(?!.*\.do)|find/i.test(path)) {
        role = 'lookup';
        label = this.guessLabel(api, '查询');
      } else if (/genNo/i.test(path)) {
        role = 'auxiliary';
        label = '生成编号';
      }

      steps.push({
        id: `step_${steps.length + 1}`,
        label,
        role,
        api,
        dependsOn: [],
        outputFields: [],
        inputMappings: [],
        isConditional: false,
      });
    }

    // Mark the last 'create' step as 'submit'
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].role === 'create') {
        steps[i].role = 'submit';
        steps[i].label = steps[i].label.replace('创建', '提交');
        break;
      }
    }

    return steps;
  }

  private guessLabel(api: HarApiEntry, prefix: string): string {
    const path = api.path;
    // Extract entity name from URL: /admin/saveStyleHd.do → 款式
    const entityMap: Record<string, string> = {
      Style: '款式', GoHd: '大货订单', Brand: '品牌', Customer: '客户',
      SoHd: '样品单', Order: '订单', Product: '产品', User: '用户',
    };
    for (const [key, name] of Object.entries(entityMap)) {
      if (path.includes(key)) return `${prefix}${name}`;
    }
    return `${prefix} ${path.replace(/^.*\//, '').replace(/\.do$/, '')}`;
  }

  private buildDependencies(steps: WorkflowStep[]) {
    // Collect response values from each step
    const stepOutputs = new Map<string, Map<string, any>>(); // stepId → { fieldPath → value }

    for (const step of steps) {
      const vals = new Map<string, any>();
      this.extractValues(step.api.responseBody, '', vals);
      stepOutputs.set(step.id, vals);
    }

    // For each step, check if its request body contains values from prior steps
    for (let j = 1; j < steps.length; j++) {
      const reqVals = new Map<string, any>();
      this.extractValues(steps[j].api.requestBody, '', reqVals);

      for (let i = 0; i < j; i++) {
        const priorOutputs = stepOutputs.get(steps[i].id)!;
        for (const [reqField, reqVal] of reqVals) {
          if (this.isTrivalValue(reqVal)) continue;
          for (const [outField, outVal] of priorOutputs) {
            if (this.isTrivalValue(outVal)) continue;
            if (String(reqVal) === String(outVal)) {
              if (!steps[j].dependsOn.includes(steps[i].id)) {
                steps[j].dependsOn.push(steps[i].id);
              }
              steps[j].inputMappings.push({
                field: reqField,
                fromStep: steps[i].id,
                fromField: outField,
              });
              if (!steps[i].outputFields.includes(outField)) {
                steps[i].outputFields.push(outField);
              }
            }
          }
        }
      }
    }
  }

  private extractValues(obj: any, prefix: string, result: Map<string, any>) {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
      result.set(prefix || 'value', obj);
      return;
    }
    if (Array.isArray(obj)) {
      // Only check first element for patterns
      if (obj.length > 0 && typeof obj[0] === 'object') {
        this.extractValues(obj[0], prefix + '[0]', result);
      }
      return;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        this.extractValues(v, prefix ? `${prefix}.${k}` : k, result);
      }
    }
  }

  private isTrivalValue(val: any): boolean {
    if (val === null || val === undefined) return true;
    const s = String(val);
    if (s.length < 2) return true; // skip '', '0', '1', etc.
    if (['true', 'false', 'null', 'N', 'Y', '0', '1'].includes(s)) return true;
    if (/^\d{1,3}$/.test(s)) return true; // small numbers
    return false;
  }

  private detectConditionals(steps: WorkflowStep[]) {
    for (let i = 0; i < steps.length - 1; i++) {
      if (steps[i].role !== 'lookup') continue;
      // Check if next step is create for the same entity
      const lookupEntity = this.extractEntityName(steps[i].api.url);
      for (let j = i + 1; j < Math.min(i + 3, steps.length); j++) {
        if (steps[j].role === 'create' || steps[j].role === 'submit') {
          const createEntity = this.extractEntityName(steps[j].api.url);
          if (lookupEntity && createEntity && lookupEntity === createEntity) {
            steps[j].isConditional = true;
            steps[j].conditionDescription = `仅当"${steps[i].label}"未找到结果时执行`;
            break;
          }
        }
      }
    }
  }

  private extractEntityName(url: string): string | null {
    const path = this.extractPath(url);
    // /admin/saveStyleHd.do → StyleHd
    // /admin/listGenBrand.do → GenBrand
    const match = path.match(/(?:save|list|get|create|checkIn|add|query)(\w+)\.do/i);
    return match ? match[1] : null;
  }

  private pruneSteps(steps: WorkflowStep[]): WorkflowStep[] {
    // Keep: login, lookup, create, submit, auxiliary with dependents or genNo
    const dependedOn = new Set<string>();
    for (const s of steps) {
      for (const dep of s.dependsOn) dependedOn.add(dep);
    }

    return steps.filter(s => {
      if (s.role !== 'auxiliary') return true;
      if (dependedOn.has(s.id)) return true;
      if (/genNo/i.test(s.api.url)) return true;
      return false;
    });
  }

  extractParameters(submitStep: WorkflowStep): WorkflowParameter[] {
    const body = submitStep.api.requestBody;
    if (!body || typeof body !== 'object') return [];

    // Find the main payload object (e.g., goHd, styleHd)
    let payload = body;
    const keys = Object.keys(body);
    if (keys.length === 1 && typeof body[keys[0]] === 'object') {
      payload = body[keys[0]];
    }

    const params: WorkflowParameter[] = [];
    const skipFields = /dbId|dbid|class|createDate|createUser|logger|com$|isHid|isShow|status/i;
    const systemFields = /coordinator|zdExRate_zd|exceedAllowed|shortAllowed/i;

    const fieldLabels: Record<string, string> = {
      goNo: '订单号', styleNo: '款式号', styleDesc: '款式名称', styleDescEn: '款式英文名',
      genCustomer: '客户', genBrand: '品牌', tradeType: '贸易类型', orderType: '订单类型',
      currency: '币种', price: '单价', tradeTerm: '价格方式', payTerm: '付款方式',
      balancePayWithin: '应收货款天数', totalQty: '总数量', amount: '总金额',
      signDate: '签订日期', custArea: '消费者国别', season: '季节',
      styleRemarks: '面料说明', commision: '佣金(%)', ageGroup: '消费者年龄段',
      decHeader: '报关抬头', originalSource: '原样来源', aqlLevel: 'AQL等级',
      terminalRetailPrice: '终端零售价', zdCurrency: '零售货币', zdExRate: '汇率',
      exRate: '当期汇率', shortName: '简称', styleName: '款式全称',
    };

    for (const [key, val] of Object.entries(payload)) {
      if (skipFields.test(key)) continue;
      if (systemFields.test(key)) continue;
      if (typeof val === 'object' && val !== null) {
        // Nested object (like genCustomer: {dbId, shortName})
        // Extract the user-facing field (shortName, description, etc.)
        const userField = (val as any).shortName || (val as any).description || (val as any).fullname;
        if (userField !== undefined) {
          params.push({
            name: key,
            source: `${keys.length === 1 ? keys[0] + '.' : ''}${key}.shortName`,
            description: fieldLabels[key] || key,
            required: /customer|brand|style/i.test(key),
            type: 'string',
            sampleValue: userField,
          });
        }
        continue;
      }

      params.push({
        name: key,
        source: `${keys.length === 1 ? keys[0] + '.' : ''}${key}`,
        description: fieldLabels[key] || key,
        required: /goNo|customer|brand|styleNo|tradeType|orderType|currency/i.test(key),
        type: typeof val === 'number' ? 'number' : 'string',
        sampleValue: val,
      });
    }

    return params;
  }
}
