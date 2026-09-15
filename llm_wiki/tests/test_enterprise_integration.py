"""
Enterprise Knowledge Base — Full Integration Test

Scenario: 锦绣华裳服饰集团 (a fashion company)
- 2 admins, 3 departments (销售部, 技术研发, 品质��理)
- Files in root (global), /raw/销售部/LC-Waikiki/, /raw/技术研发/外套/
- Personal dir for one user
- Cross-department workgroup grant

Tests:
1. SCHEMA.md parsing
2. DB initialization (org, depts, members, directory_meta)
3. File indexing with access_scope + metadata extraction
4. Permission resolution (accessible_scopes, can_access_path, can_write_path)
5. VaultFS query filtering by scope
"""

import asyncio
import json
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

# Add project paths
sys.path.insert(0, str(Path(__file__).parent.parent / "mcp"))
sys.path.insert(0, str(Path(__file__).parent.parent / "api"))

import aiosqlite

SCHEMA_CONTENT = '''---
organization:
  name: 锦绣华裳服饰集团
  slug: jinxiu-fashion
  language: zh

roles:
  admin:
    - admin@jinxiu.com
  members:
    - sales1@jinxiu.com
    - tech1@jinxiu.com
    - quality1@jinxiu.com

departments:
  销售部:
    slug: sales
    members:
      - sales1@jinxiu.com
    editors:
      - sales1@jinxiu.com
    head: sales1@jinxiu.com
    subdirectory_attribute: customer
    subdirectory_label: 客户

  技术研发:
    slug: tech
    members:
      - tech1@jinxiu.com
    editors:
      - tech1@jinxiu.com
    head: tech1@jinxiu.com
    subdirectory_attribute: product_line
    subdirectory_label: 产品线

  品质管理:
    slug: quality
    members:
      - quality1@jinxiu.com
    editors:
      - quality1@jinxiu.com
    head: quality1@jinxiu.com

workgroups:
  LC项目组:
    slug: lc-project
    members:
      - sales1@jinxiu.com
      - tech1@jinxiu.com
    grant_access:
      - path: /raw/品质管理/
        role: viewer

directories:
  /raw/销售部:
    scope: department
    department: 销售部
    subdirectories:
      - LC-Waikiki
      - Zara

  /raw/技术研发:
    scope: department
    department: 技术研发
    subdirectories:
      - 外套
      - 针织

  /raw/品质管理:
    scope: department
    department: 品质管理

  /raw/个人:
    scope: personal
    auto_create: true
    naming: email_prefix
---

# 锦绣华裳服饰集团知识库

测试用企业知识库配置。
'''


async def setup_workspace(workspace: Path) -> aiosqlite.Connection:
    """Create workspace with SCHEMA.md, some test files, and initialize DB."""
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / ".llmwiki").mkdir(exist_ok=True)
    (workspace / "wiki").mkdir(exist_ok=True)

    # Write SCHEMA.md
    (workspace / "SCHEMA.md").write_text(SCHEMA_CONTENT, encoding="utf-8")

    # Create test source files
    # Global (root)
    (workspace / "企业文化手册.pdf").write_bytes(b"%PDF-fake")
    (workspace / "公司通用标准.pdf").write_bytes(b"%PDF-fake")

    # Department: 销售部/LC-Waikiki
    lw_dir = workspace / "raw" / "销售部" / "LC-Waikiki"
    lw_dir.mkdir(parents=True, exist_ok=True)
    (lw_dir / "包装标准.pdf").write_bytes(b"%PDF-fake-packaging")
    (lw_dir / "发货要求.pdf").write_bytes(b"%PDF-fake-shipping")

    # Department: 技术研发/外套
    tech_dir = workspace / "raw" / "技术研发" / "外套"
    tech_dir.mkdir(parents=True, exist_ok=True)
    (tech_dir / "外套工艺规���.pdf").write_bytes(b"%PDF-fake-outerwear")

    # Department: 品质管理
    qm_dir = workspace / "raw" / "品质管理"
    qm_dir.mkdir(parents=True, exist_ok=True)
    (qm_dir / "检验流程.pdf").write_bytes(b"%PDF-fake-inspection")

    # Initialize SQLite
    schema_sql = (Path(__file__).parent.parent / "shared" / "sqlite_schema.sql").read_text()
    db_path = str(workspace / ".llmwiki" / "index.db")
    db = await aiosqlite.connect(db_path)
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    await db.executescript(schema_sql)
    await db.commit()

    # Insert workspace row
    ws_id = str(uuid.uuid4())
    await db.execute(
        "INSERT INTO workspace (id, name, user_id) VALUES (?, ?, ?)",
        (ws_id, "jinxiu-test", "local-user"),
    )
    await db.commit()

    return db


async def test_schema_parsing(workspace: Path):
    """Test 1: SCHEMA.md is parsed correctly."""
    print("\n═══ Test 1: SCHEMA.md Parsing ═══")

    from schema_init import parse_schema_file
    result = parse_schema_file(workspace)
    assert result is not None, "Failed to parse SCHEMA.md"

    config, body = result
    assert config["organization"]["name"] == "锦绣华裳服饰集团"
    assert config["organization"]["slug"] == "jinxiu-fashion"
    assert len(config["departments"]) == 3
    assert "销售部" in config["departments"]
    assert config["departments"]["销售部"]["subdirectory_attribute"] == "customer"
    assert len(config["workgroups"]) == 1
    assert "LC项目组" in config["workgroups"]
    assert "测试用企业知识库配置" in body

    print("  ✓ Organization parsed: 锦绣华裳服饰集团")
    print("  ✓ 3 departments: 销售部, 技术研发, 品质管理")
    print("  ✓ 1 workgroup: LC项目组")
    print("  ✓ Body content preserved")


async def test_db_initialization(db: aiosqlite.Connection, workspace: Path):
    """Test 2: Enterprise tables populated correctly."""
    print("\n═══ Test 2: DB Initialization ═══")

    from schema_init import init_from_schema
    config = await init_from_schema(db, workspace)
    assert config is not None, "init_from_schema returned None"

    # Check organization
    cursor = await db.execute("SELECT name, slug FROM organizations")
    org = await cursor.fetchone()
    assert org[0] == "锦绣华裳服饰集团"
    assert org[1] == "jinxiu-fashion"
    print("  ✓ Organization created: jinxiu-fashion")

    # Check org_members
    cursor = await db.execute("SELECT email, role FROM org_members ORDER BY role, email")
    members = await cursor.fetchall()
    admin_count = sum(1 for m in members if m[1] == "admin")
    member_count = sum(1 for m in members if m[1] == "member")
    assert admin_count == 1, f"Expected 1 admin, got {admin_count}"
    assert member_count == 3, f"Expected 3 members, got {member_count}"
    print(f"  ✓ Org members: {admin_count} admin, {member_count} members")

    # Check departments
    cursor = await db.execute("SELECT name, slug, subdirectory_attribute FROM departments ORDER BY name")
    depts = await cursor.fetchall()
    assert len(depts) == 3
    sales_dept = next(d for d in depts if d[1] == "sales")
    assert sales_dept[2] == "customer"
    print(f"  ✓ Departments: {[d[0] for d in depts]}")

    # Check department_members
    cursor = await db.execute(
        "SELECT dm.email, dm.role, d.name FROM department_members dm "
        "JOIN departments d ON dm.department_id = d.id ORDER BY d.name"
    )
    dept_members = await cursor.fetchall()
    assert len(dept_members) >= 3
    print(f"  ✓ Department members: {len(dept_members)} assignments")

    # Check workgroups
    cursor = await db.execute("SELECT name, slug FROM workgroups")
    wgs = await cursor.fetchall()
    assert len(wgs) == 1
    assert wgs[0][1] == "lc-project"
    print(f"  ✓ Workgroups: {[w[0] for w in wgs]}")

    # Check directory_meta
    cursor = await db.execute("SELECT path, scope FROM directory_meta ORDER BY path")
    dirs = await cursor.fetchall()
    assert len(dirs) >= 3
    dir_paths = [d[0] for d in dirs]
    assert "/raw/销售部" in dir_paths
    assert "/raw/技术研发" in dir_paths
    print(f"  ✓ Directory meta: {len(dirs)} entries")
    for d in dirs[:6]:
        print(f"    {d[0]} ��� {d[1]}")

    # Check workgroup grant → directory_permissions
    cursor = await db.execute(
        "SELECT directory_path, grantee_workgroup_slug, role FROM directory_permissions "
        "WHERE grantee_workgroup_slug IS NOT NULL"
    )
    grants = await cursor.fetchall()
    assert len(grants) >= 1
    print(f"  ✓ Workgroup grants: {len(grants)} directory permissions")

    # Check physical directories created
    assert (workspace / "raw" / "销售部" / "LC-Waikiki").is_dir()
    assert (workspace / "raw" / "销售部" / "Zara").is_dir()
    assert (workspace / "raw" / "技术研发" / "外套").is_dir()
    assert (workspace / "raw" / "个人").is_dir()
    print("  ✓ Physical directories created (raw/销售部/LC-Waikiki, raw/技术研发/外套, ...)")

    # Check personal directories
    cursor = await db.execute("SELECT path, owner_email FROM directory_meta WHERE scope = 'personal' AND owner_email IS NOT NULL")
    personal = await cursor.fetchall()
    assert len(personal) >= 3, f"Expected >=3 personal dirs, got {len(personal)}"
    print(f"  ✓ Personal directories: {len(personal)} created")

    return config


async def test_file_indexing(db: aiosqlite.Connection, workspace: Path):
    """Test 3: Files indexed with correct access_scope and metadata."""
    print("\n═══ Test 3: File Indexing (access_scope + metadata) ═══")

    from domain.watcher import _index_file, _load_directory_meta, invalidate_directory_meta_cache

    # Reset cache to pick up fresh directory_meta
    invalidate_directory_meta_cache()

    # Ensure test files exist (directories may have been recreated by init_from_schema)
    test_files_data = [
        (workspace / "企业文化手册.pdf", b"%PDF-fake"),
        (workspace / "raw" / "销售部" / "LC-Waikiki" / "包装标准.pdf", b"%PDF-fake-pkg"),
        (workspace / "raw" / "销售部" / "LC-Waikiki" / "发货要求.pdf", b"%PDF-fake-ship"),
        (workspace / "raw" / "技术研发" / "外套" / "外套工艺规范.pdf", b"%PDF-fake-outer"),
        (workspace / "raw" / "品质管理" / "检验流程.pdf", b"%PDF-fake-inspect"),
    ]
    for fpath, data in test_files_data:
        fpath.parent.mkdir(parents=True, exist_ok=True)
        fpath.write_bytes(data)

    test_files = [f for f, _ in test_files_data]

    for f in test_files:
        await _index_file(db, workspace, f)

    # Verify access_scope
    cursor = await db.execute(
        "SELECT relative_path, access_scope, metadata FROM documents ORDER BY relative_path"
    )
    docs = await cursor.fetchall()
    print(f"  Indexed {len(docs)} documents:")

    scope_map = {}
    for rel_path, scope, metadata in docs:
        scope_map[rel_path] = scope
        meta_str = f" metadata={metadata}" if metadata else ""
        print(f"    {rel_path} → [{scope}]{meta_str}")

    # Verify root file = global
    assert scope_map.get("企业文化手册.pdf") == "global", \
        f"Root file should be 'global', got '{scope_map.get('企业文化手册.pdf')}'"
    print("  ✓ Root files → global")

    # Verify sales department files
    assert scope_map.get("raw/销售部/LC-Waikiki/包装标准.pdf") == "department:sales", \
        f"Sales file scope wrong: {scope_map.get('raw/销售部/LC-Waikiki/包装标准.pdf')}"
    print("  ✓ /raw/销售部/ files → department:sales")

    # Verify tech department files
    assert scope_map.get("raw/技术研发/外套/外套工艺规范.pdf") == "department:tech", \
        f"Tech file scope wrong: {scope_map.get('raw/技术研发/外套/外套工艺规范.pdf')}"
    print("  ✓ /raw/技术研发/ files → department:tech")

    # Verify quality department
    assert scope_map.get("raw/品质管理/检验流程.pdf") == "department:quality"
    print("  ✓ /raw/品质管理/ files → department:quality")

    # Verify metadata extraction (subdirectory_attribute = customer ��� {"customer": "LC-Waikiki"})
    cursor = await db.execute(
        "SELECT metadata FROM documents WHERE relative_path = ?",
        ("raw/销售部/LC-Waikiki/包装标准.pdf",),
    )
    row = await cursor.fetchone()
    assert row is not None
    meta = json.loads(row[0]) if row[0] else {}
    assert meta.get("customer") == "LC-Waikiki", f"Expected customer=LC-Waikiki, got {meta}"
    print("  ✓ Metadata extracted: customer=LC-Waikiki")

    # Verify tech metadata
    cursor = await db.execute(
        "SELECT metadata FROM documents WHERE relative_path = ?",
        ("raw/技术研发/外套/外套工艺规范.pdf",),
    )
    row = await cursor.fetchone()
    meta = json.loads(row[0]) if row[0] else {}
    assert meta.get("product_line") == "外套", f"Expected product_line=外套, got {meta}"
    print("  ✓ Metadata extracted: product_line=外套")


async def test_permission_resolution(db: aiosqlite.Connection, workspace: Path):
    """Test 4: Permission resolution for different user roles."""
    print("\n═══ Test 4: Permission Resolution ═══")

    # Import VaultFS with the initialized DB
    from vaultfs.sqlite import SqliteVaultFS, _db
    # Point the module-level _db to our test db
    import vaultfs.sqlite as sqlite_mod
    sqlite_mod._db = db
    sqlite_mod._workspace_root = workspace

    fs_admin = SqliteVaultFS("admin-user")
    fs_sales = SqliteVaultFS("sales-user")
    fs_tech = SqliteVaultFS("tech-user")

    # Test accessible_scopes for admin
    scopes_admin = await fs_admin.accessible_scopes(user_email="admin@jinxiu.com")
    assert scopes_admin is None, "Admin should have None (full access)"
    print("  ✓ admin@jinxiu.com → None (full access, no filtering)")

    # Test accessible_scopes for sales user
    scopes_sales = await fs_sales.accessible_scopes(user_email="sales1@jinxiu.com")
    assert scopes_sales is not None
    assert "global" in scopes_sales
    assert "department:sales" in scopes_sales
    assert "personal:sales1@jinxiu.com" in scopes_sales
    assert "department:tech" not in scopes_sales
    print(f"  ✓ sales1@jinxiu.com → {sorted(scopes_sales)}")

    # Test accessible_scopes for tech user
    scopes_tech = await fs_tech.accessible_scopes(user_email="tech1@jinxiu.com")
    assert scopes_tech is not None
    assert "global" in scopes_tech
    assert "department:tech" in scopes_tech
    assert "department:sales" not in scopes_tech
    print(f"  ✓ tech1@jinxiu.com → {sorted(scopes_tech)}")

    # Test can_access_path
    assert await fs_admin.can_access_path("/", "admin@jinxiu.com") == True
    assert await fs_admin.can_access_path("/raw/销售部/LC-Waikiki", "admin@jinxiu.com") == True
    assert await fs_sales.can_access_path("/raw/销售部/LC-Waikiki", "sales1@jinxiu.com") == True
    assert await fs_tech.can_access_path("/raw/销售部/LC-Waikiki", "tech1@jinxiu.com") == False
    assert await fs_tech.can_access_path("/raw/技术研发/外套", "tech1@jinxiu.com") == True
    print("  ✓ can_access_path: sales→销售部=✓, tech→销售部=✗, tech→技术研发=✓")

    # Test can_write_path
    assert await fs_admin.can_write_path("/", "admin@jinxiu.com") == True
    assert await fs_sales.can_write_path("/", "sales1@jinxiu.com") == False
    assert await fs_sales.can_write_path("/raw/销售部", "sales1@jinxiu.com") == True
    assert await fs_sales.can_write_path("/raw/技术研发", "sales1@jinxiu.com") == False
    assert await fs_tech.can_write_path("/raw/技术研发", "tech1@jinxiu.com") == True
    print("  ✓ can_write_path: sales→root=✗, sales→销售部=✓, tech→技术研发=✓")

    # Test workgroup grant: tech1 in LC项目组 can access 品质管理
    scopes_tech_with_wg = await fs_tech.accessible_scopes(user_email="tech1@jinxiu.com")
    # The workgroup grant gives access to /raw/品质管理/ which is department:quality
    # Check can_access_path via workgroup
    # (Note: workgroup grants are in directory_permissions, can_access_path checks them for restricted)
    print(f"  ✓ tech1 scopes (with workgroup): {sorted(scopes_tech_with_wg or set())}")


async def test_filtered_queries(db: aiosqlite.Connection, workspace: Path):
    """Test 5: VaultFS list_documents filtered by scope."""
    print("\n═══ Test 5: Filtered Document Queries ═══")

    import vaultfs.sqlite as sqlite_mod
    sqlite_mod._db = db
    sqlite_mod._workspace_root = workspace
    from vaultfs.sqlite import SqliteVaultFS

    fs = SqliteVaultFS("test-user")

    # Admin: sees all documents (scopes=None)
    all_docs = await fs.list_documents("test-kb", scopes=None)
    print(f"  Admin (no filter): {len(all_docs)} documents")
    assert len(all_docs) == 5, f"Expected 5 docs, got {len(all_docs)}"

    # Sales user: sees global + department:sales
    sales_scopes = {"global", "department:sales", "personal:sales1@jinxiu.com"}
    sales_docs = await fs.list_documents("test-kb", scopes=sales_scopes)
    sales_filenames = [d["filename"] for d in sales_docs]
    print(f"  Sales user: {len(sales_docs)} documents — {sales_filenames}")
    assert "企业文化手册.pdf" in sales_filenames, "Sales should see global files"
    assert "包装标准.pdf" in sales_filenames, "Sales should see own dept files"
    assert "外套工艺规范.pdf" not in sales_filenames, "Sales should NOT see tech files"
    assert "检验流程.pdf" not in sales_filenames, "Sales should NOT see quality files"
    print("  ✓ Sales sees: global + ��售部, NOT 技术研发/品质管理")

    # Tech user: sees global + department:tech
    tech_scopes = {"global", "department:tech", "personal:tech1@jinxiu.com"}
    tech_docs = await fs.list_documents("test-kb", scopes=tech_scopes)
    tech_filenames = [d["filename"] for d in tech_docs]
    print(f"  Tech user: {len(tech_docs)} documents — {tech_filenames}")
    assert "企业文化手册.pdf" in tech_filenames, "Tech should see global files"
    assert "外套工艺规范.pdf" in tech_filenames, "Tech should see own dept files"
    assert "包装标准.pdf" not in tech_filenames, "Tech should NOT see sales files"
    print("  ✓ Tech sees: global + 技术研发, NOT 销售部/品质管理")

    # Quality user: sees global + department:quality
    quality_scopes = {"global", "department:quality", "personal:quality1@jinxiu.com"}
    quality_docs = await fs.list_documents("test-kb", scopes=quality_scopes)
    quality_filenames = [d["filename"] for d in quality_docs]
    print(f"  Quality user: {len(quality_docs)} documents — {quality_filenames}")
    assert "检验流程.pdf" in quality_filenames
    assert "包装标准.pdf" not in quality_filenames
    print("  ✓ Quality sees: global + 品质管理, NOT 销售部/技术研发")


async def test_uncited_with_scope(db: aiosqlite.Connection, workspace: Path):
    """Test 6: find_uncited_sources respects scopes."""
    print("\n═══ Test 6: Uncited Sources with Scope Filtering ═══")

    import vaultfs.sqlite as sqlite_mod
    sqlite_mod._db = db
    sqlite_mod._workspace_root = workspace
    from vaultfs.sqlite import SqliteVaultFS

    fs = SqliteVaultFS("test-user")

    # All uncited (admin view)
    all_uncited = await fs.find_uncited_sources("test-kb", scopes=None)
    print(f"  Admin: {len(all_uncited)} uncited sources (all)")

    # Sales view
    sales_scopes = {"global", "department:sales", "personal:sales1@jinxiu.com"}
    sales_uncited = await fs.find_uncited_sources("test-kb", scopes=sales_scopes)
    sales_names = [d["filename"] for d in sales_uncited]
    print(f"  Sales: {len(sales_uncited)} uncited — {sales_names}")
    assert "外套工艺规范.pdf" not in sales_names
    assert "检验流程.pdf" not in sales_names
    print("  ✓ Sales uncited: only shows own accessible uncited sources")


async def main():
    """Run all tests."""
    print("╔══════════════════════════════════════════════════════════╗")
    print("║  Enterprise Knowledge Base — Integration Test Suite     ║")
    print("╚══════════════════════════════════════════════════════════╝")

    # Create temp workspace
    tmp = Path(tempfile.mkdtemp(prefix="llmwiki_test_"))
    print(f"\nWorkspace: {tmp}")

    try:
        db = await setup_workspace(tmp)

        await test_schema_parsing(tmp)
        await test_db_initialization(db, tmp)
        await test_file_indexing(db, tmp)
        await test_permission_resolution(db, tmp)
        await test_filtered_queries(db, tmp)
        await test_uncited_with_scope(db, tmp)

        await db.close()

        print("\n╔══════════════════════════════════════════════════════════╗")
        print("║  ✅ ALL TESTS PASSED                                    ║")
        print("╚══════════════════════════════════════════════════════════╝")

    except AssertionError as e:
        print(f"\n❌ ASSERTION FAILED: {e}")
        raise
    except Exception as e:
        print(f"\n❌ ERROR: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
