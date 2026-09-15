"""RBAC permissions CRUD routes for the knowledge base system.

Manages directory metadata, directory permissions, departments, and workgroups.
Local mode only (SQLite).
"""

from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

router = APIRouter(prefix="/v1/admin", tags=["permissions"])


def _get_db(request: Request):
    db = getattr(request.app.state, "sqlite_db", None)
    if db is None:
        raise HTTPException(status_code=501, detail="Only available in local mode")
    return db


async def _ensure_org(db, org_id: str) -> None:
    """Auto-create organization if it doesn't exist (for local mode convenience)."""
    cursor = await db.execute("SELECT id FROM organizations WHERE id = ?", (org_id,))
    if await cursor.fetchone():
        return
    await db.execute(
        "INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)",
        (org_id, org_id, org_id),
    )
    await db.commit()


# ── Pydantic models ──────────────────────────────────────────────────────────


class DirectoryMetaCreate(BaseModel):
    path: str
    scope: str = "global"
    department_id: str | None = None
    owner_email: str | None = None
    description: str | None = None
    subdirectory_attribute: str | None = None
    subdirectory_label: str | None = None


class PermissionGrant(BaseModel):
    directory_path: str
    grantee_email: str | None = None
    grantee_department_slug: str | None = None
    grantee_workgroup_slug: str | None = None
    role: str = "viewer"


class DepartmentCreate(BaseModel):
    org_id: str
    name: str
    slug: str
    parent_id: str | None = None
    head_email: str | None = None


class WorkgroupCreate(BaseModel):
    org_id: str
    name: str
    slug: str


# ── Directory metadata ───────────────────────────────────────────────────────


@router.get("/directories")
async def list_directories(request: Request):
    db = _get_db(request)
    cursor = await db.execute("SELECT * FROM directory_meta ORDER BY path")
    rows = await cursor.fetchall()
    columns = [d[0] for d in cursor.description]
    return [dict(zip(columns, row)) for row in rows]


@router.post("/directories", status_code=201)
async def create_or_update_directory(body: DirectoryMetaCreate, request: Request):
    db = _get_db(request)

    if body.scope not in ("global", "department", "personal", "restricted"):
        raise HTTPException(status_code=400, detail="Invalid scope")

    # Upsert: if path already exists, update it
    cursor = await db.execute(
        "SELECT id FROM directory_meta WHERE path = ?", (body.path,)
    )
    existing = await cursor.fetchone()

    if existing:
        await db.execute(
            """UPDATE directory_meta
               SET scope = ?, department_id = ?, owner_email = ?,
                   description = ?, subdirectory_attribute = ?, subdirectory_label = ?
               WHERE path = ?""",
            (
                body.scope, body.department_id, body.owner_email,
                body.description, body.subdirectory_attribute, body.subdirectory_label,
                body.path,
            ),
        )
        await db.commit()
        row_id = existing[0]
    else:
        row_id = uuid4().hex
        await db.execute(
            """INSERT INTO directory_meta
               (id, path, scope, department_id, owner_email, description,
                subdirectory_attribute, subdirectory_label)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                row_id, body.path, body.scope, body.department_id,
                body.owner_email, body.description,
                body.subdirectory_attribute, body.subdirectory_label,
            ),
        )
        await db.commit()

    cursor = await db.execute("SELECT * FROM directory_meta WHERE id = ?", (row_id,))
    row = await cursor.fetchone()
    columns = [d[0] for d in cursor.description]
    return dict(zip(columns, row))


@router.delete("/directories/{path:path}", status_code=204)
async def delete_directory(path: str, request: Request):
    db = _get_db(request)
    cursor = await db.execute("DELETE FROM directory_meta WHERE path = ?", (path,))
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Directory metadata not found")


# ── Directory permissions ────────────────────────────────────────────────────


@router.get("/permissions")
async def list_permissions(
    request: Request,
    directory_path: str | None = Query(None),
):
    db = _get_db(request)
    if directory_path:
        cursor = await db.execute(
            "SELECT * FROM directory_permissions WHERE directory_path = ? ORDER BY created_at",
            (directory_path,),
        )
    else:
        cursor = await db.execute(
            "SELECT * FROM directory_permissions ORDER BY directory_path, created_at"
        )
    rows = await cursor.fetchall()
    columns = [d[0] for d in cursor.description]
    return [dict(zip(columns, row)) for row in rows]


@router.post("/permissions", status_code=201)
async def grant_permission(body: PermissionGrant, request: Request):
    db = _get_db(request)

    if body.role not in ("viewer", "editor", "admin"):
        raise HTTPException(status_code=400, detail="Invalid role")

    grantee_count = sum([
        body.grantee_email is not None,
        body.grantee_department_slug is not None,
        body.grantee_workgroup_slug is not None,
    ])
    if grantee_count == 0:
        raise HTTPException(
            status_code=400,
            detail="Must specify at least one of: grantee_email, grantee_department_slug, grantee_workgroup_slug",
        )
    if grantee_count > 1:
        raise HTTPException(
            status_code=400,
            detail="Specify only one grantee type per permission entry",
        )

    row_id = uuid4().hex
    try:
        await db.execute(
            """INSERT INTO directory_permissions
               (id, directory_path, grantee_email, grantee_department_slug,
                grantee_workgroup_slug, role)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                row_id, body.directory_path, body.grantee_email,
                body.grantee_department_slug, body.grantee_workgroup_slug,
                body.role,
            ),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(
                status_code=409,
                detail="Permission already exists for this directory and grantee",
            )
        raise

    cursor = await db.execute(
        "SELECT * FROM directory_permissions WHERE id = ?", (row_id,)
    )
    row = await cursor.fetchone()
    columns = [d[0] for d in cursor.description]
    return dict(zip(columns, row))


@router.delete("/permissions/{permission_id}", status_code=204)
async def revoke_permission(permission_id: str, request: Request):
    db = _get_db(request)
    cursor = await db.execute(
        "DELETE FROM directory_permissions WHERE id = ?", (permission_id,)
    )
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Permission not found")


# ── Departments ──────────────────────────────────────────────────────────────


@router.get("/departments")
async def list_departments(request: Request):
    db = _get_db(request)
    cursor = await db.execute("SELECT * FROM departments ORDER BY name")
    rows = await cursor.fetchall()
    columns = [d[0] for d in cursor.description]
    return [dict(zip(columns, row)) for row in rows]


@router.post("/departments", status_code=201)
async def create_department(body: DepartmentCreate, request: Request):
    db = _get_db(request)
    # Auto-create organization if it doesn't exist
    await _ensure_org(db, body.org_id)
    row_id = uuid4().hex
    try:
        await db.execute(
            """INSERT INTO departments (id, org_id, parent_id, name, slug, head_email)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (row_id, body.org_id, body.parent_id, body.name, body.slug, body.head_email),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(
                status_code=409, detail="Department with this org_id and slug already exists"
            )
        raise

    cursor = await db.execute("SELECT * FROM departments WHERE id = ?", (row_id,))
    row = await cursor.fetchone()
    columns = [d[0] for d in cursor.description]
    return dict(zip(columns, row))


@router.delete("/departments/{department_id}", status_code=204)
async def delete_department(department_id: str, request: Request):
    db = _get_db(request)
    cursor = await db.execute(
        "DELETE FROM departments WHERE id = ?", (department_id,)
    )
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Department not found")


# ── Workgroups ───────────────────────────────────────────────────────────────


@router.get("/workgroups")
async def list_workgroups(request: Request):
    db = _get_db(request)
    cursor = await db.execute("SELECT * FROM workgroups ORDER BY name")
    rows = await cursor.fetchall()
    columns = [d[0] for d in cursor.description]
    return [dict(zip(columns, row)) for row in rows]


@router.post("/workgroups", status_code=201)
async def create_workgroup(body: WorkgroupCreate, request: Request):
    db = _get_db(request)
    # Auto-create organization if it doesn't exist
    await _ensure_org(db, body.org_id)
    row_id = uuid4().hex
    try:
        await db.execute(
            """INSERT INTO workgroups (id, org_id, name, slug)
               VALUES (?, ?, ?, ?)""",
            (row_id, body.org_id, body.name, body.slug),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(
                status_code=409, detail="Workgroup with this org_id and slug already exists"
            )
        raise

    cursor = await db.execute("SELECT * FROM workgroups WHERE id = ?", (row_id,))
    row = await cursor.fetchone()
    columns = [d[0] for d in cursor.description]
    return dict(zip(columns, row))


@router.delete("/workgroups/{workgroup_id}", status_code=204)
async def delete_workgroup(workgroup_id: str, request: Request):
    db = _get_db(request)
    cursor = await db.execute(
        "DELETE FROM workgroups WHERE id = ?", (workgroup_id,)
    )
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Workgroup not found")


# ── Taxonomy CRUD ────────────────────────────────────────────────────────────


class TaxonomyUpdate(BaseModel):
    categories: list[dict] = []
    synonyms: dict[str, list[str]] = {}


def _taxonomy_path(request: Request):
    """Resolve _taxonomy.yaml path from workspace."""
    wp = getattr(request.app.state, "workspace_path", None)
    if not wp:
        raise HTTPException(status_code=501, detail="Workspace path not configured")
    from pathlib import Path
    p = Path(wp) / "wiki" / "_taxonomy.yaml"
    return p


@router.get("/taxonomy")
async def get_taxonomy(request: Request):
    p = _taxonomy_path(request)
    if not p.is_file():
        return {"categories": [], "synonyms": {}}
    try:
        import yaml
        with open(p, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return {
            "categories": data.get("categories", []),
            "synonyms": data.get("synonyms", {}),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read taxonomy: {e}")


@router.put("/taxonomy")
async def update_taxonomy(body: TaxonomyUpdate, request: Request):
    p = _taxonomy_path(request)
    try:
        import yaml
        p.parent.mkdir(parents=True, exist_ok=True)
        data = {"categories": body.categories, "synonyms": body.synonyms}
        with open(p, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

        # Reload in-memory taxonomy cache
        try:
            from tools.taxonomy import load_taxonomy
            load_taxonomy(p.parent.parent)
        except Exception:
            pass

        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save taxonomy: {e}")


# ── Department members ───────────────────────────────────────────────────────


class DeptMemberCreate(BaseModel):
    email: str
    role: str = "member"


@router.get("/departments/{dept_id}/members")
async def list_dept_members(dept_id: str, request: Request):
    db = _get_db(request)
    cursor = await db.execute(
        "SELECT * FROM department_members WHERE department_id = ? ORDER BY email",
        (dept_id,),
    )
    rows = await cursor.fetchall()
    columns = [d[0] for d in cursor.description]
    return [dict(zip(columns, row)) for row in rows]


@router.post("/departments/{dept_id}/members", status_code=201)
async def add_dept_member(dept_id: str, body: DeptMemberCreate, request: Request):
    db = _get_db(request)
    if body.role not in ("member", "editor"):
        raise HTTPException(status_code=400, detail="Role must be 'member' or 'editor'")

    import hashlib
    user_id = hashlib.md5(body.email.encode()).hexdigest()
    row_id = uuid4().hex
    try:
        await db.execute(
            "INSERT INTO department_members (id, department_id, user_id, email, role) VALUES (?, ?, ?, ?, ?)",
            (row_id, dept_id, user_id, body.email, body.role),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(status_code=409, detail="Member already exists in this department")
        if "FOREIGN KEY" in str(e):
            raise HTTPException(status_code=400, detail="Invalid department_id")
        raise
    return {"id": row_id, "department_id": dept_id, "email": body.email, "role": body.role}


@router.delete("/departments/{dept_id}/members/{member_id}", status_code=204)
async def remove_dept_member(dept_id: str, member_id: str, request: Request):
    db = _get_db(request)
    cursor = await db.execute(
        "DELETE FROM department_members WHERE id = ? AND department_id = ?",
        (member_id, dept_id),
    )
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Member not found")


# ── Workgroup members ────────────────────────────────────────────────────────


class WgMemberCreate(BaseModel):
    email: str


@router.get("/workgroups/{wg_id}/members")
async def list_wg_members(wg_id: str, request: Request):
    db = _get_db(request)
    cursor = await db.execute(
        "SELECT * FROM workgroup_members WHERE workgroup_id = ? ORDER BY email",
        (wg_id,),
    )
    rows = await cursor.fetchall()
    columns = [d[0] for d in cursor.description]
    return [dict(zip(columns, row)) for row in rows]


@router.post("/workgroups/{wg_id}/members", status_code=201)
async def add_wg_member(wg_id: str, body: WgMemberCreate, request: Request):
    db = _get_db(request)
    row_id = uuid4().hex
    try:
        await db.execute(
            "INSERT INTO workgroup_members (id, workgroup_id, email) VALUES (?, ?, ?)",
            (row_id, wg_id, body.email),
        )
        await db.commit()
    except Exception as e:
        if "UNIQUE constraint" in str(e):
            raise HTTPException(status_code=409, detail="Member already exists in this workgroup")
        if "FOREIGN KEY" in str(e):
            raise HTTPException(status_code=400, detail="Invalid workgroup_id")
        raise
    return {"id": row_id, "workgroup_id": wg_id, "email": body.email}


@router.delete("/workgroups/{wg_id}/members/{member_id}", status_code=204)
async def remove_wg_member(wg_id: str, member_id: str, request: Request):
    db = _get_db(request)
    cursor = await db.execute(
        "DELETE FROM workgroup_members WHERE id = ? AND workgroup_id = ?",
        (member_id, wg_id),
    )
    await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Member not found")
