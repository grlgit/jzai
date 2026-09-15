"""PDF extraction via opendataloader-pdf.

Shared module used by both the hosted OCR service and the local processor.
No server-specific dependencies (no asyncpg, S3, httpx).
"""

import json
import shutil
import tempfile
from collections import defaultdict
from pathlib import Path

import opendataloader_pdf


def _element_to_markdown(el: dict, image_map: dict[str, str] | None = None) -> str:
    """Convert a single JSON element to markdown."""
    t = el.get("type", "")
    content = el.get("content", "")

    if t == "heading":
        level = max(1, min(el.get("heading level", 1), 6))
        prefix = "#" * level
        return f"{prefix} {content}"

    if t == "paragraph":
        return content

    if t == "list":
        lines = []
        for item in el.get("list items", []):
            lines.append(f"- {item.get('content', '')}")
            for child in item.get("kids", []):
                lines.append(f"  - {child.get('content', '')}")
        return "\n".join(lines)

    if t == "image":
        src = el.get("source", "")
        if src and image_map and src in image_map:
            return f"![image]({image_map[src]})"
        elif src:
            return f"![image]({src})"
        return ""

    if t == "caption":
        return f"*{content}*" if content else ""

    # Skip headers, footers, and unknown types
    return ""


def _elements_to_pages(
    elements: list[dict], total_pages: int, image_map: dict[str, str] | None = None
) -> list[tuple[int, str]]:
    """Group JSON elements by page number and reconstruct markdown per page.

    Returns a list of (page_num, markdown) for every page up to total_pages,
    using empty string for pages with no extractable content.
    """
    page_elements: dict[int, list[dict]] = defaultdict(list)

    for el in elements:
        page_num = el.get("page number")
        if page_num is None or el.get("type") in ("header", "footer"):
            continue
        page_elements[page_num].append(el)

    pages = []
    for page_num in range(1, total_pages + 1):
        parts = []
        for el in page_elements.get(page_num, []):
            md = _element_to_markdown(el, image_map)
            if md:
                parts.append(md)
        pages.append((page_num, "\n\n".join(parts)))

    return pages


def extract_pdf(pdf_path: str, assets_dir: str | None = None) -> list[tuple[int, str]]:
    """Run opendataloader-pdf and return per-page markdown from structured JSON output.

    If assets_dir is provided, images are extracted from the PDF and saved there.
    Markdown will reference images relative to the assets directory.

    Raises RuntimeError if extraction fails (Java missing, corrupt PDF, etc.).
    """
    try:
        with tempfile.TemporaryDirectory() as extract_dir:
            image_tmp_dir = Path(extract_dir) / "images"
            image_tmp_dir.mkdir()

            convert_kwargs = dict(
                input_path=pdf_path,
                output_dir=extract_dir,
                format="json",
                quiet=True,
            )

            if assets_dir:
                convert_kwargs["image_output"] = "external"
                convert_kwargs["image_format"] = "png"
                convert_kwargs["image_dir"] = str(image_tmp_dir)

            opendataloader_pdf.convert(**convert_kwargs)

            json_files = list(Path(extract_dir).glob("*.json"))
            if not json_files:
                raise RuntimeError("opendataloader-pdf produced no output")

            with open(json_files[0], encoding="utf-8") as f:
                data = json.load(f)

            # Copy extracted images to assets_dir and build mapping
            image_map: dict[str, str] = {}
            if assets_dir:
                assets_path = Path(assets_dir)
                assets_path.mkdir(parents=True, exist_ok=True)

                for img_file in image_tmp_dir.iterdir():
                    if img_file.is_file() and img_file.suffix.lower() in (".png", ".jpg", ".jpeg"):
                        dest = assets_path / img_file.name
                        shutil.copy2(img_file, dest)
                        # Map all possible source references to the bare filename
                        image_map[img_file.name] = img_file.name
                        image_map[str(img_file)] = img_file.name
                        # opendataloader uses "images/<filename>" as source
                        image_map[f"images/{img_file.name}"] = img_file.name

        total_pages = data.get("number of pages", 0)
        elements = data.get("kids", [])
        return _elements_to_pages(elements, total_pages, image_map if assets_dir else None)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"PDF extraction failed: {e}") from e
