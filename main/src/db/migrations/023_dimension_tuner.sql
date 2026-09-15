-- PDF尺寸识别可视化参数调优系统
-- 创建参数配置、参数版本、测试样本、测试结果表

-- 1. 参数配置表
CREATE TABLE IF NOT EXISTS dimension_param_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT NOT NULL, -- 'merge', 'search', 'threshold', 'weight', 'filter', 'dimension'
  param_key TEXT NOT NULL UNIQUE,
  value_type TEXT NOT NULL, -- 'number', 'boolean', 'string'
  default_value TEXT NOT NULL,
  current_value TEXT NOT NULL,
  min_value TEXT,
  max_value TEXT,
  step_value TEXT DEFAULT '1',
  unit TEXT,
  validation_regex TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 参数版本表
CREATE TABLE IF NOT EXISTS dimension_param_versions (
  id TEXT PRIMARY KEY,
  version_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT FALSE,
  is_baseline BOOLEAN DEFAULT FALSE,
  created_by TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  params_json JSONB NOT NULL -- 所有参数值作为JSON
);

-- 3. 测试样本表
CREATE TABLE IF NOT EXISTS dimension_test_samples (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  file_path TEXT NOT NULL,
  file_hash TEXT,
  category TEXT DEFAULT 'general',
  expected_dimensions JSONB NOT NULL, -- Ground truth dimensions
  expected_count INTEGER NOT NULL,
  critical_dimensions TEXT[] DEFAULT '{}', -- 关键尺寸值（如1328.50、1388.50）
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 测试结果表
CREATE TABLE IF NOT EXISTS dimension_test_results (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES dimension_test_samples(id),
  version_id TEXT REFERENCES dimension_param_versions(id),
  params_snapshot JSONB NOT NULL, -- 测试时使用的参数快照

  -- 检测结果
  detected_count INTEGER NOT NULL,
  expected_count INTEGER NOT NULL,
  detected_dimensions JSONB NOT NULL,

  -- 准确率指标
  true_positives INTEGER DEFAULT 0,
  false_positives INTEGER DEFAULT 0,
  false_negatives INTEGER DEFAULT 0,
  precision NUMERIC(5,4),
  recall NUMERIC(5,4),
  f1_score NUMERIC(5,4),

  -- 关键尺寸检测
  critical_detected TEXT[] DEFAULT '{}',
  critical_missed TEXT[] DEFAULT '{}',

  -- 性能
  processing_time_ms INTEGER,

  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_param_configs_category ON dimension_param_configs(category);
CREATE INDEX IF NOT EXISTS idx_param_configs_key ON dimension_param_configs(param_key);
CREATE INDEX IF NOT EXISTS idx_param_versions_active ON dimension_param_versions(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_param_versions_baseline ON dimension_param_versions(is_baseline);
CREATE INDEX IF NOT EXISTS idx_test_samples_category ON dimension_test_samples(category);
CREATE INDEX IF NOT EXISTS idx_test_results_sample ON dimension_test_results(sample_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_results_version ON dimension_test_results(version_id, created_at DESC);

-- 插入默认参数配置
INSERT INTO dimension_param_configs (id, name, description, category, param_key, value_type, default_value, current_value, min_value, max_value, step_value, unit) VALUES
-- 文本合并参数
('param_merge_threshold', '文本合并阈值', '相邻文本项合并的最大距离（像素）', 'merge', 'mergeThreshold', 'number', '15', '15', '5', '50', '1', 'px'),

-- 图形搜索参数
('param_search_radius', '图形搜索半径', '在文本周围搜索图形特征的范围（像素）', 'search', 'searchRadius', 'number', '50', '50', '20', '200', '5', 'px'),

-- 线条检测参数
('param_thin_line_threshold', '细线阈值', '小于此宽度的线条被认为是细线（像素）', 'threshold', 'thinLineThreshold', 'number', '3', '3', '1', '10', '0.5', 'px'),
('param_short_line_threshold', '短线阈值', '小于此长度的线条被认为是短线（像素）', 'threshold', 'shortLineThreshold', 'number', '100', '100', '20', '500', '10', 'px'),

-- 置信度权重参数
('param_weight_thin_lines', '细线权重', '附近有细线的置信度提升', 'weight', 'nearbyThinLines', 'number', '0.4', '0.4', '0', '1', '0.05', ''),
('param_weight_hv_lines', '水平垂直线权重', '有水平和垂直线条的置信度提升', 'weight', 'horizontalVerticalLines', 'number', '0.3', '0.3', '0', '1', '0.05', ''),
('param_weight_endpoints', '端点权重', '附近有端点的置信度提升', 'weight', 'nearbyEndpoints', 'number', '0.05', '0.05', '0', '1', '0.01', ''),
('param_weight_dense_lines', '密集线条权重', '周围线条密集的置信度提升', 'weight', 'denseLines', 'number', '0.15', '0.15', '0', '1', '0.05', ''),

-- 尺寸线分析参数
('param_min_dim_line_length', '最小尺寸线长度', '尺寸线最小长度（像素）', 'dimension', 'minDimensionLineLength', 'number', '5', '5', '1', '50', '1', 'px'),
('param_max_text_line_dist', '最大文本线距离', '文本与尺寸线最大距离（像素）', 'dimension', 'maxTextToLineDistance', 'number', '50', '50', '10', '200', '5', 'px'),

-- 数值范围过滤参数
('param_min_value', '最小数值', '保留尺寸的最小数值', 'filter', 'minValue', 'number', '0.01', '0.01', '0', '100', '0.01', ''),
('param_max_value', '最大数值', '保留尺寸的最大数值', 'filter', 'maxValue', 'number', '10000', '10000', '100', '50000', '100', ''),

-- 去重参数
('param_position_tolerance', '位置容差', '尺寸去重的位置容差（像素）', 'filter', 'positionTolerance', 'number', '5', '5', '1', '20', '1', 'px')
ON CONFLICT (param_key) DO NOTHING;

-- 创建基线版本
INSERT INTO dimension_param_versions (id, version_name, description, is_active, is_baseline, params_json) VALUES
('version_baseline', 'Baseline (Default)', '默认参数值', TRUE, TRUE,
 '{"mergeThreshold":15,"searchRadius":50,"thinLineThreshold":3,"shortLineThreshold":100,"nearbyThinLines":0.4,"horizontalVerticalLines":0.3,"nearbyEndpoints":0.05,"denseLines":0.15,"minDimensionLineLength":5,"maxTextToLineDistance":50,"minValue":0.01,"maxValue":10000,"positionTolerance":5}')
ON CONFLICT (id) DO NOTHING;

-- 插入初始测试样本（GZ-LXXB-01）
-- 注意：实际使用时需要通过API更新file_path
INSERT INTO dimension_test_samples (id, name, description, file_path, category, expected_dimensions, expected_count, critical_dimensions) VALUES
('sample_gz_lxxb_01', 'GZ-LXXB-01 尾部盲板法兰', '法兰类零件测试样本，包含关键外径尺寸1328.50和1388.50', '/path/to/GZ-LXXB-01.pdf', 'flange',
 '[]'::jsonb, 35,
 ARRAY['1328.50', '1388.50', '700', '1090', '1150', '1180', '1240'])
ON CONFLICT (id) DO NOTHING;
