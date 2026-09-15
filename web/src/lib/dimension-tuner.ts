import { loadAdminKey, handle401 } from './admin-auth';

const API_BASE = '/api/dimension-tuner';

let cachedKey = '';
async function getAdminKey() {
  if (!cachedKey) {
    cachedKey = await loadAdminKey();
  }
  return cachedKey;
}

async function apiRequest(endpoint: string, options?: RequestInit) {
  const key = await getAdminKey();
  if (!key) {
    handle401();
    throw new Error('Unauthorized');
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': key,
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    handle401();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error: ${response.status} - ${error}`);
  }

  return response.json();
}

// ========== 参数管理 ==========

export async function getParameters() {
  return apiRequest('/parameters');
}

export async function updateParameter(key: string, value: any) {
  return apiRequest(`/parameters/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

export async function batchUpdateParameters(updates: Array<{ key: string; value: any }>) {
  return apiRequest('/parameters/batch', {
    method: 'POST',
    body: JSON.stringify({ updates }),
  });
}

export async function resetParameters(toVersion?: string) {
  return apiRequest('/parameters/reset', {
    method: 'POST',
    body: JSON.stringify({ toVersion }),
  });
}

export async function saveAsVersion(name: string, description?: string) {
  return apiRequest('/parameters/save-version', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
}

// ========== PDF解析和过滤 ==========

export async function parsePdf(filePath: string) {
  return apiRequest('/parse', {
    method: 'POST',
    body: JSON.stringify({ filePath }),
  });
}

export async function filterDimensions(dimensions: any[], params: Record<string, any>) {
  return apiRequest('/filter', {
    method: 'POST',
    body: JSON.stringify({ dimensions, params }),
  });
}

// ========== 版本管理 ==========

export async function getVersions() {
  return apiRequest('/versions');
}

export async function createVersion(name: string, description?: string) {
  return apiRequest('/versions', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
}

export async function activateVersion(id: string) {
  return apiRequest(`/versions/${id}/activate`, {
    method: 'PUT',
  });
}

export async function compareVersions(id: string, withId: string) {
  return apiRequest(`/versions/${id}/compare?with=${withId}`);
}

export async function deleteVersion(id: string) {
  return apiRequest(`/versions/${id}`, {
    method: 'DELETE',
  });
}

// ========== 样本管理 ==========

export async function getSamples(category?: string) {
  const params = category ? `?category=${category}` : '';
  return apiRequest(`/samples${params}`);
}

export async function createSample(data: {
  name: string;
  description?: string;
  filePath: string;
  category?: string;
  expectedDimensions?: any[];
  expectedCount: number;
  criticalDimensions?: string[];
}) {
  return apiRequest('/samples', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateSample(
  id: string,
  data: {
    expectedDimensions?: any[];
    expectedCount?: number;
    criticalDimensions?: string[];
  },
) {
  return apiRequest(`/samples/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteSample(id: string) {
  return apiRequest(`/samples/${id}`, {
    method: 'DELETE',
  });
}

// ========== 测试执行 ==========

export async function runTest(sampleId: string, params?: Record<string, any>) {
  return apiRequest('/test', {
    method: 'POST',
    body: JSON.stringify({ sampleId, params }),
  });
}

export async function runBatchTests(sampleIds: string[], versionId?: string) {
  return apiRequest('/test/batch', {
    method: 'POST',
    body: JSON.stringify({ sampleIds, versionId }),
  });
}

export async function getTestResults(sampleId?: string, versionId?: string) {
  const params = new URLSearchParams();
  if (sampleId) params.set('sampleId', sampleId);
  if (versionId) params.set('versionId', versionId);
  return apiRequest(`/test/results?${params}`);
}

export async function getTestResult(resultId: string) {
  return apiRequest(`/test/results/${resultId}`);
}

export async function compareWithBaseline(resultId: string) {
  return apiRequest(`/test/compare/${resultId}`);
}

// ========== 分析和优化 ==========

export async function getPerformanceTrends(limit?: number) {
  return apiRequest(`/analytics/performance${limit ? `?limit=${limit}` : ''}`);
}
