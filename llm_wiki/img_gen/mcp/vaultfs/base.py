from abc import ABC, abstractmethod


class VaultFS(ABC):
    """Abstract virtual filesystem for the knowledge vault."""

    user_id: str

    @abstractmethod
    async def resolve_kb(self, slug: str) -> dict | None: ...

    @abstractmethod
    async def list_knowledge_bases(self) -> list[dict]: ...

    @abstractmethod
    async def get_document(self, kb_id: str, filename: str, dir_path: str) -> dict | None: ...

    @abstractmethod
    async def find_document_by_name(self, kb_id: str, name: str) -> dict | None: ...

    @abstractmethod
    async def create_document(self, kb_id: str, filename: str, title: str, dir_path: str, file_type: str, content: str, tags: list[str], date: str | None = None, metadata: dict | None = None) -> dict: ...

    @abstractmethod
    async def update_document(self, doc_id: str, content: str, tags: list[str] | None = None, title: str | None = None, date: str | None = None, metadata: dict | None = None) -> dict | None: ...

    @abstractmethod
    async def archive_documents(self, doc_ids: list[str]) -> int: ...

    @abstractmethod
    async def list_documents(self, kb_id: str) -> list[dict]: ...

    @abstractmethod
    async def list_documents_with_content(self, kb_id: str) -> list[dict]: ...

    @abstractmethod
    async def get_pages(self, doc_id: str, page_nums: list[int]) -> list[dict]: ...

    @abstractmethod
    async def get_all_pages(self, doc_id: str) -> list[dict]: ...

    @abstractmethod
    async def search_chunks(self, kb_id: str, query: str, limit: int, path_filter: str | None = None) -> list[dict]: ...

    @abstractmethod
    async def load_source_bytes(self, doc: dict) -> bytes | None: ...

    @abstractmethod
    async def load_image_bytes(self, doc_id: str, image_id: str) -> bytes | None: ...

    @abstractmethod
    def write_to_disk(self, dir_path: str, filename: str, content: str) -> bool: ...

    @abstractmethod
    def delete_from_disk(self, docs: list[dict]) -> None: ...

    @abstractmethod
    async def delete_references(self, source_doc_id: str) -> None: ...

    @abstractmethod
    async def upsert_reference(self, source_id: str, target_id: str, kb_id: str, ref_type: str, page: int | None) -> None: ...

    @abstractmethod
    async def propagate_staleness(self, doc_id: str) -> None: ...

    @abstractmethod
    async def get_backlinks(self, doc_id: str) -> list[dict]: ...

    @abstractmethod
    async def get_forward_references(self, doc_id: str) -> list[dict]: ...

    @abstractmethod
    async def find_uncited_sources(self, kb_id: str) -> list[dict]: ...

    @abstractmethod
    async def find_stale_pages(self, kb_id: str) -> list[dict]: ...

    @abstractmethod
    async def search_documents_full(self, kb_id: str, query: str, limit: int, path_filter: str | None = None) -> list[dict]:
        """Full-text search returning complete document content for matched documents.

        Unlike search_chunks which returns individual chunk snippets, this method
        returns the full content of each matching document, deduplicated by document.
        Results are ordered by best chunk match score.
        """
        ...

    @abstractmethod
    async def search_documents_by_content(self, kb_id: str, keywords: list[str], limit: int, path_filter: str | None = None) -> list[dict]:
        """Fallback content search using LIKE matching on documents.content.

        Used when documents lack chunk indexes (e.g., wiki markdown pages).
        Returns documents whose content contains ANY of the given keywords,
        ordered by the number of keywords matched (most relevant first).
        """
        ...
