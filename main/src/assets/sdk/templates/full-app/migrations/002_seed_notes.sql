-- 种子两条示例，便于安装后立即看到效果
INSERT INTO fa_notes (id, title, content) VALUES
  ('seed_welcome', '欢迎使用备忘本', '这是安装时自动写入的示例笔记，可以直接删除。'),
  ('seed_usage', '使用提示', '在面板里新增/删除笔记；也可以让助手用 fa_note_add 帮你记。')
ON CONFLICT (id) DO NOTHING;
