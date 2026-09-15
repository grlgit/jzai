import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { SkillRegistryService, SkillDefinition } from './skill-registry.service';

export interface DiscoveredApi {
  method: string;
  url: string;
  contentType: string;
  headers: Record<string, string>;
  body: any;
  status: number;
  responseBody?: any;
  timestamp: number;
}

export interface DiscoveredField {
  selector: string;
  tagName: string;
  type: string;      // text, number, select, textarea, date, password, checkbox, radio
  name: string;       // name or id attribute
  label: string;      // associated label text
  options?: string[]; // for select elements
  required: boolean;
  placeholder?: string;
}

export interface DiscoveryResult {
  system: string;
  targetUrl: string;
  formAction?: string;
  loginApi?: DiscoveredApi;
  businessApis: DiscoveredApi[];
  formFields: DiscoveredField[];
  navigationPath: string[];
  screenshots: string[];
  timestamp: number;
}

export interface RecordingAction {
  type: 'click' | 'type' | 'scroll' | 'navigate' | 'screenshot';
  x?: number;
  y?: number;
  text?: string;
  url?: string;
  deltaY?: number;
  timestamp: number;
  screenshot?: string;
}

export interface RecordingSession {
  id: string;
  page: any;
  context: any;
  capturedApis: DiscoveredApi[];
  actions: RecordingAction[];
  formFields: DiscoveredField[];
  recording: boolean;
  onProgress?: (data: any) => void;
}

@Injectable()
export class SkillDiscoveryService {
  private readonly logger = new Logger(SkillDiscoveryService.name);
  private browser: any = null;
  private sessions = new Map<string, RecordingSession>();

  constructor(private readonly registry: SkillRegistryService) {}

  /**
   * Full discovery flow: login → navigate → analyze form → fill & submit → capture API
   */
  async discover(params: {
    systemUrl: string;
    systemName: string;
    loginUrl?: string;
    credentials?: { username: string; password: string };
    navigationSteps: string[];  // e.g. ["全部功能", "ERP", "订单管理", "新增大货订单"]
    skillName: string;
  }): Promise<DiscoveryResult> {
    const { chromium } = await import('playwright');
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      this.logger.log('Discovery browser launched');
    }

    const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const capturedApis: DiscoveredApi[] = [];
    const screenshots: string[] = [];
    let loginApi: DiscoveredApi | undefined;

    // Network interception
    page.on('request', (req: any) => {
      // Ignore static assets
      const url = req.url();
      if (/\.(css|js|png|jpg|gif|svg|ico|woff|ttf)(\?|$)/.test(url)) return;
      if (req.resourceType() === 'image' || req.resourceType() === 'stylesheet' || req.resourceType() === 'font') return;
    });

    page.on('response', async (resp: any) => {
      const req = resp.request();
      const url = req.url();
      const method = req.method();

      // Skip static resources and GET requests for pages
      if (/\.(css|js|png|jpg|gif|svg|ico|woff|ttf)(\?|$)/.test(url)) return;
      if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;

      try {
        let body: any = null;
        const postData = req.postData();
        if (postData) {
          try { body = JSON.parse(postData); } catch { body = postData; }
        }

        let responseBody: any = null;
        try {
          const respText = await resp.text();
          try { responseBody = JSON.parse(respText); } catch { responseBody = respText?.substring(0, 2000); }
        } catch {}

        const contentType = req.headers()['content-type'] || '';

        const api: DiscoveredApi = {
          method,
          url,
          contentType,
          headers: this.filterHeaders(req.headers()),
          body,
          status: resp.status(),
          responseBody,
          timestamp: Date.now(),
        };

        // Detect login API
        if (!loginApi && (url.includes('login') || url.includes('auth') || url.includes('signin'))) {
          if (method === 'POST') {
            loginApi = api;
            this.logger.log(`Detected login API: ${method} ${url}`);
          }
        }

        capturedApis.push(api);
      } catch {}
    });

    try {
      // Step 1: Login
      const loginUrl = params.loginUrl || params.systemUrl;
      this.logger.log(`Discovery: navigating to ${loginUrl}`);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      if (params.credentials) {
        await this.autoLogin(page, params.credentials);
        await page.waitForTimeout(4000);
        screenshots.push(await this.screenshot(page));
        this.logger.log(`Logged in, current URL: ${page.url()}`);
      }

      // Step 2: Navigate through menu (longer waits for ExtJS rendering)
      for (const step of params.navigationSteps) {
        this.logger.log(`Navigation: clicking "${step}"`);
        await this.clickByText(page, step);
        await page.waitForTimeout(3000);
      }
      screenshots.push(await this.screenshot(page));
      this.logger.log(`Navigation complete, current URL: ${page.url()}`);

      // Step 3: Wait for dynamic content (ExtJS etc.) and analyze form
      await page.waitForTimeout(3000);
      const formFields = await this.analyzeForm(page);
      this.logger.log(`Found ${formFields.length} form fields`);

      // Step 4: Discover the form submit URL from DOM / ExtJS config
      let formAction = await this.discoverFormAction(page);
      this.logger.log(`Discovered form action: ${formAction || '(none)'}`);

      // Step 5: Fill form with test data and submit
      if (formFields.length > 0) {
        const preSubmitCount = capturedApis.length;

        await this.fillFormFields(page, formFields);
        screenshots.push(await this.screenshot(page));

        // Inject XHR spy to catch ExtJS form.submit() URL
        await page.evaluate(() => {
          (window as any).__discoveredSubmitUrl = null;
          const origOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method: string, url: string, ...args: any[]) {
            if (method.toUpperCase() === 'POST' && /save|create|submit|add|insert|store/i.test(url)) {
              (window as any).__discoveredSubmitUrl = url;
            }
            // Also capture any POST with form-like body
            if (method.toUpperCase() === 'POST') {
              (window as any).__lastPostUrl = url;
            }
            return origOpen.apply(this, [method, url, ...args] as any);
          };
        });

        await this.clickSubmit(page);
        await page.waitForTimeout(3000);
        screenshots.push(await this.screenshot(page));

        // Retrieve the submit URL from XHR spy
        const xhrSubmitUrl = await page.evaluate(() => {
          return (window as any).__discoveredSubmitUrl || (window as any).__lastPostUrl || null;
        });
        if (xhrSubmitUrl && !formAction) {
          try {
            formAction = new URL(xhrSubmitUrl, page.url()).href;
          } catch {
            formAction = xhrSubmitUrl;
          }
          this.logger.log(`XHR spy captured submit URL: ${formAction}`);
        }

        this.logger.log(`Captured ${capturedApis.length - preSubmitCount} new APIs after form submission`);
      }

      const result: DiscoveryResult = {
        system: params.systemName,
        targetUrl: page.url(),
        formAction,
        loginApi,
        businessApis: capturedApis.filter(a => a !== loginApi),
        formFields,
        navigationPath: params.navigationSteps,
        screenshots,
        timestamp: Date.now(),
      };

      // Save discovery data
      const skillDir = path.join(process.cwd(), 'config', 'skills', params.skillName);
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'discovery.json'),
        JSON.stringify(result, null, 2),
        'utf-8',
      );

      // Auto-generate skill from discovery
      this.generateSkill(params.skillName, params.systemName, result);

      return result;
    } finally {
      await context.close();
    }
  }

  /**
   * Analyze the current page for form fields.
   * Supports: standard HTML forms, ExtJS, Ant Design, Element UI.
   */
  private async analyzeForm(page: any): Promise<DiscoveredField[]> {
    return page.evaluate(() => {
      const fields: any[] = [];
      const seen = new Set<string>();

      function isVisible(el: HTMLElement): boolean {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      /**
       * Find label text for a form element by traversing up the DOM
       */
      function findLabel(el: HTMLElement): string {
        // 1. <label for="id">
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.textContent?.trim() || '';
        }

        // 2. Walk up to find a form item container and its label
        let parent: HTMLElement | null = el;
        for (let i = 0; i < 8 && parent; i++) {
          parent = parent.parentElement;
          if (!parent) break;
          const cls = parent.className || '';

          // ExtJS: x-form-item, x-field
          if (/x-form-item|x-field\b/.test(cls)) {
            const lbl = parent.querySelector('.x-form-item-label, .x-form-item-label-text, label');
            if (lbl) return lbl.textContent?.trim().replace(/[:：\s*]+$/, '') || '';
          }

          // Standard / Ant Design / Element UI
          if (/form-group|form-item|ant-form-item|el-form-item|field-row/.test(cls)) {
            const lbl = parent.querySelector('label, .label, .field-label, .ant-form-item-label, .el-form-item__label');
            if (lbl) return lbl.textContent?.trim().replace(/[:：\s*]+$/, '') || '';
          }

          // Table row: look for <td> label
          if (parent.tagName === 'TR') {
            const cells = parent.querySelectorAll('td');
            for (const td of cells) {
              if (td.contains(el)) continue;
              const text = td.textContent?.trim().replace(/[:：\s*]+$/, '');
              if (text && text.length < 20) return text;
            }
          }
        }

        // 3. Previous sibling
        const prev = el.previousElementSibling;
        if (prev) {
          const text = prev.textContent?.trim().replace(/[:：\s*]+$/, '');
          if (text && text.length < 30) return text;
        }

        return el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';
      }

      function addField(el: HTMLInputElement, extraType?: string) {
        const type = extraType || (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type?.toLowerCase() || 'text');
        if (['hidden', 'submit', 'button', 'file', 'image', 'reset'].includes(type)) return;
        if (!isVisible(el)) return;

        const name = el.name || el.id || '';
        const key = name || `${el.tagName}_${el.getBoundingClientRect().x}_${el.getBoundingClientRect().y}`;
        if (seen.has(key)) return;
        seen.add(key);

        const selector = name ? `[name="${name}"]` : el.id ? `#${el.id}` : '';
        if (!selector) return;

        const field: any = {
          selector,
          tagName: el.tagName.toLowerCase(),
          type,
          name,
          label: findLabel(el),
          required: el.required || el.getAttribute('aria-required') === 'true' || el.className?.includes('required'),
          placeholder: el.placeholder || '',
        };

        if (el.tagName === 'SELECT') {
          field.options = Array.from((el as unknown as HTMLSelectElement).options).map(o => o.text).filter(t => t);
        }

        fields.push(field);
      }

      // Strategy 1: Standard inputs
      document.querySelectorAll('input, select, textarea').forEach((el) => {
        addField(el as HTMLInputElement);
      });

      // Strategy 2: ExtJS form items — ExtJS wraps inputs deep in divs
      // Look for .x-form-item containers that contain inputs we might have missed
      document.querySelectorAll('.x-form-item, .x-field').forEach((item) => {
        const inputs = item.querySelectorAll('input, textarea, select');
        inputs.forEach((el) => {
          addField(el as HTMLInputElement);
        });
      });

      // Strategy 3: ExtJS comboboxes — they use a hidden input + visible trigger div
      // Find inputs with role="combobox" or ext-specific classes
      document.querySelectorAll('input[role="combobox"], .x-form-trigger-wrap input, .x-combo-list input').forEach((el) => {
        addField(el as HTMLInputElement, 'select');
      });

      // Strategy 4: contenteditable divs (some frameworks use these)
      document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
        const div = el as HTMLElement;
        if (!isVisible(div)) return;
        const key = `editable_${div.getBoundingClientRect().x}_${div.getBoundingClientRect().y}`;
        if (seen.has(key)) return;
        seen.add(key);
        fields.push({
          selector: div.id ? `#${div.id}` : `[contenteditable="true"]`,
          tagName: 'div',
          type: 'text',
          name: div.id || '',
          label: findLabel(div),
          required: false,
          placeholder: '',
        });
      });

      return fields;
    });
  }

  /**
   * Discover the form submit URL by inspecting:
   * 1. HTML <form action="...">
   * 2. ExtJS Ext.form.FormPanel url config
   * 3. ExtJS BasicForm url
   * 4. Infer from page URL patterns
   */
  private async discoverFormAction(page: any): Promise<string | undefined> {
    const action = await page.evaluate(() => {
      // 1. HTML form action
      const forms = document.querySelectorAll('form[action]');
      for (const form of forms) {
        const action = form.getAttribute('action');
        if (action && action !== '#' && action !== '' && !action.startsWith('javascript:')) {
          return action;
        }
      }

      // 2. ExtJS: search Ext.ComponentManager for FormPanel
      const Ext = (window as any).Ext;
      if (Ext?.ComponentManager) {
        const all = Ext.ComponentManager.all;
        const items = all?.getValues?.() || all?.items || [];
        for (const cmp of items) {
          // FormPanel or BasicForm with url
          if (cmp?.getForm && typeof cmp.getForm === 'function') {
            try {
              const form = cmp.getForm();
              if (form?.url) return form.url;
            } catch {}
          }
          if (cmp?.url && cmp?.isFormField !== true) {
            const url = cmp.url;
            if (typeof url === 'string' && url.includes('.do')) return url;
          }
          if (cmp?.xtype === 'form' || cmp?.xtype === 'formpanel') {
            if (cmp.url) return cmp.url;
            if (cmp.initialConfig?.url) return cmp.initialConfig.url;
          }
        }
      }

      // 3. ExtJS3: Ext.getCmp or form panels in Ext.FormPanel registry
      if (Ext?.form?.BasicForm?.prototype) {
        // Search DOM for form elements with ext-gen ids
        const extForms = document.querySelectorAll('form');
        for (const f of extForms) {
          const id = f.id;
          if (id && Ext.getCmp) {
            try {
              const cmp = Ext.getCmp(id);
              if (cmp?.getForm?.()?.url) return cmp.getForm().url;
            } catch {}
          }
        }
      }

      return null;
    });

    if (action) {
      // Resolve relative URL
      const baseUrl = page.url();
      try {
        return new URL(action, baseUrl).href;
      } catch {
        return action;
      }
    }

    // 4. Infer from captured API patterns
    // Look at existing API URLs for the "save/create" pattern
    return undefined;
  }

  /**
   * Fill form fields with test data
   */
  private async fillFormFields(page: any, fields: DiscoveredField[]) {
    for (const field of fields) {
      try {
        const el = page.locator(field.selector).first();
        if (!await el.isVisible({ timeout: 500 }).catch(() => false)) continue;

        const testValue = this.generateTestValue(field);
        if (!testValue) continue;

        if (field.type === 'select') {
          // Select first non-empty option
          const options = await el.locator('option').allTextContents();
          const validOption = options.find((o: string) => o.trim() && o !== '请选择' && o !== '--');
          if (validOption) await el.selectOption({ label: validOption });
        } else if (field.type === 'checkbox' || field.type === 'radio') {
          await el.check().catch(() => {});
        } else {
          await el.fill(testValue);
        }
        this.logger.debug(`Filled ${field.name}: ${testValue}`);
      } catch {
        // Skip fields that can't be filled
      }
    }
  }

  /**
   * Generate test data based on field type and label
   */
  private generateTestValue(field: DiscoveredField): string {
    const label = (field.label + ' ' + field.name + ' ' + (field.placeholder || '')).toLowerCase();

    if (field.type === 'number') return '100';
    if (field.type === 'date') {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (field.type === 'email') return 'test@example.com';
    if (field.type === 'tel') return '13800138000';

    // Guess by label/name
    if (/客户|customer/i.test(label)) return '测试客户';
    if (/产品|product|款号/i.test(label)) return '测试产品';
    if (/数量|qty|quantity/i.test(label)) return '100';
    if (/价格|price|单价/i.test(label)) return '50';
    if (/金额|amount/i.test(label)) return '5000';
    if (/日期|date|交期/i.test(label)) {
      const d = new Date(Date.now() + 7 * 86400000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (/备注|remark|note|说明/i.test(label)) return 'API探索测试数据';
    if (/订单号|order.*no/i.test(label)) return `TEST-${Date.now() % 100000}`;

    return '测试数据';
  }

  /**
   * Auto-login by finding username/password fields and submit button
   */
  private async autoLogin(page: any, creds: { username: string; password: string }) {
    // Find username field
    const userSelectors = ['input[name="username"]', 'input[name="user"]', 'input[name="account"]',
      'input[type="text"]:first-of-type', '#username', '#user'];
    for (const sel of userSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.fill(creds.username);
          break;
        }
      } catch {}
    }

    // Find password field
    const pwSelectors = ['input[type="password"]', 'input[name="password"]', '#password'];
    for (const sel of pwSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.fill(creds.password);
          break;
        }
      } catch {}
    }

    // Click submit
    await this.clickSubmit(page);
  }

  /**
   * Click a submit/confirm button
   */
  private async clickSubmit(page: any) {
    const submitSelectors = [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("登入")', 'button:has-text("登录")', 'button:has-text("提交")',
      'button:has-text("保存")', 'button:has-text("确定")', 'button:has-text("确认")',
      'button:has-text("Submit")', 'button:has-text("Save")', 'button:has-text("OK")',
      '.submit-btn', '.btn-submit', '.btn-primary',
    ];
    for (const sel of submitSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.click();
          this.logger.debug(`Clicked submit: ${sel}`);
          return;
        }
      } catch {}
    }
  }

  /**
   * Click an element by its visible text
   */
  private async clickByText(page: any, text: string) {
    // Try multiple strategies
    const strategies = [
      () => page.locator(`text="${text}"`).first().click({ timeout: 3000 }),
      () => page.locator(`a:has-text("${text}")`).first().click({ timeout: 3000 }),
      () => page.locator(`button:has-text("${text}")`).first().click({ timeout: 3000 }),
      () => page.locator(`span:has-text("${text}")`).first().click({ timeout: 3000 }),
      () => page.locator(`div:has-text("${text}")`).first().click({ timeout: 3000 }),
    ];
    for (const strategy of strategies) {
      try {
        await strategy();
        return;
      } catch {}
    }
    this.logger.warn(`Could not find clickable element with text: "${text}"`);
  }

  /**
   * Generate skill definition from discovery result
   */
  private generateSkill(skillName: string, systemName: string, result: DiscoveryResult) {
    // Determine the submit API URL with priority:
    // 1. formAction discovered from ExtJS/HTML form
    // 2. Captured POST API matching save/create/submit pattern
    // 3. Infer from URL pattern of other captured APIs
    let apiUrl = '';
    let apiMethod = 'POST';
    let apiContentType = 'application/x-www-form-urlencoded';

    if (result.formAction) {
      apiUrl = result.formAction;
      this.logger.log(`Using form action: ${apiUrl}`);
    } else {
      // Look for save/create/submit/add in captured APIs
      const savePatterns = /save|create|submit|add|insert|new|store/i;
      const candidateApis = result.businessApis.filter(a =>
        a.method === 'POST' && savePatterns.test(a.url)
      );

      if (candidateApis.length > 0) {
        apiUrl = candidateApis[0].url;
        apiContentType = candidateApis[0].contentType || apiContentType;
        this.logger.log(`Using matched save API: ${apiUrl}`);
      } else {
        // Infer from URL patterns: find the most common path prefix with .do
        const urlPrefixes = new Map<string, number>();
        for (const a of result.businessApis) {
          const match = a.url.match(/^(https?:\/\/[^/]+\/[^/]+\/)/);
          if (match) urlPrefixes.set(match[1], (urlPrefixes.get(match[1]) || 0) + 1);
        }
        const topPrefix = Array.from(urlPrefixes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (topPrefix) {
          // Guess: prefix + save + entity name from navigation
          const lastNav = result.navigationPath[result.navigationPath.length - 1] || '';
          apiUrl = `${topPrefix}(需手动确认提交URL)`;
          this.logger.log(`Could not auto-detect submit URL, using prefix: ${topPrefix}`);
        }
      }
    }

    // Build parameters from form fields
    const parameters = result.formFields
      .filter(f => f.type !== 'checkbox' && f.type !== 'radio')
      .map(f => ({
        name: f.name,
        type: f.type === 'number' ? 'number' : 'string',
        required: f.required,
        description: f.label || f.name,
      }));

    const paramsList = parameters.map(p => `- **${p.name}** (${p.type}${p.required ? ', 必填' : ''}): ${p.description}`).join('\n');
    const instructions = `## 工作流程\n\n执行${systemName}的${skillName}操作。\n\n## 参数\n\n${paramsList}\n\n## API\n\n- 目标: ${apiUrl || result.targetUrl}\n- 方法: ${apiMethod}\n- 导航路径: ${result.navigationPath.join(' → ')}`;

    const skill: SkillDefinition = {
      name: skillName,
      description: `${systemName} - ${skillName}`,
      instructions,
      metadata: { system: systemName, version: '1.0' },
      dirName: skillName,
      hasHandler: true,
      hasReferences: false,
      hasAssets: false,
    };

    // Generate handler code
    const handlerCode = this.generateHandler(skill, result);

    this.registry.save(skill, handlerCode);
    this.logger.log(`Generated skill: ${skillName}`);
  }

  /**
   * Generate handler.ts code from skill definition and discovery data
   */
  private generateHandler(skill: SkillDefinition, result: DiscoveryResult): string {
    const loginApi = result.loginApi;
    const businessApi = result.businessApis.find(a => a.method === 'POST' && a.body) || result.businessApis[0];

    const paramEntries = (result.formFields || []).map((f: any) => `  ${f.name}: params.${f.name},`).join('\n');
    const apiUrl = businessApi?.url || result.targetUrl;
    const systemName = skill.metadata?.system || skill.name;

    return `// Auto-generated skill handler for: ${skill.name}
// System: ${systemName}
// Generated: ${new Date().toISOString()}

async function execute(ctx) {
  var params = typeof ctx.params.input === 'string' ? JSON.parse(ctx.params.input) : ctx.params;
${loginApi ? `  // Step 1: Login
  var loginResp = await ctx.http.post('${loginApi.url}', ${JSON.stringify(loginApi.body || {})});
  if (loginResp.status >= 400) {
    return { success: false, message: '登录失败: ' + loginResp.status };
  }
` : '  // No login required'}
  // Step 2: Call business API
  var resp = await ctx.http.${(businessApi?.method || 'post').toLowerCase()}('${apiUrl}', params);

  return {
    success: resp.status >= 200 && resp.status < 300,
    message: resp.status < 300 ? '操作成功' : '操作失败: ' + resp.status,
    data: resp.data,
  };
}
`;
  }

  private filterHeaders(headers: Record<string, string>): Record<string, string> {
    const skip = ['accept-encoding', 'sec-', 'user-agent', 'connection', 'host', 'origin', 'referer'];
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (skip.some(s => k.toLowerCase().startsWith(s))) continue;
      filtered[k] = v;
    }
    return filtered;
  }

  private async screenshot(page: any): Promise<string> {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
    return buf.toString('base64');
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
