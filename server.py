import os
import re
import html
import base64
from pathlib import Path

import httpx
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv(Path(__file__).parent / ".env")

CONFLUENCE_BASE = os.getenv("CONFLUENCE_BASE_URL", "").rstrip("/")
CONFLUENCE_USER = os.getenv("CONFLUENCE_USERNAME", "")
CONFLUENCE_TOKEN = os.getenv("CONFLUENCE_API_TOKEN", "")

app = FastAPI(title="Mermaid Editor – Confluence Bridge")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _auth_header() -> dict:
    creds = base64.b64encode(f"{CONFLUENCE_USER}:{CONFLUENCE_TOKEN}".encode()).decode()
    return {"Authorization": f"Basic {creds}", "Accept": "application/json"}


def _http_client() -> httpx.Client:
    return httpx.Client(headers=_auth_header(), timeout=30, verify=False)


# ── Extraer código Mermaid del storage format de Confluence ──────────────

def extract_mermaid_from_storage(storage_value: str) -> str | None:
    """Busca código Mermaid dentro de macros HTML o code blocks de Confluence."""

    soup = BeautifulSoup(storage_value, "html.parser")

    # 1) Macro HTML con <div class="mermaid">
    for macro in soup.find_all("ac:structured-macro", attrs={"ac:name": "html"}):
        body_tag = macro.find("ac:plain-text-body")
        if not body_tag:
            continue
        raw = body_tag.get_text()
        inner = BeautifulSoup(raw, "html.parser")
        mermaid_div = inner.find("div", class_="mermaid")
        if mermaid_div:
            return mermaid_div.get_text().strip()

    # 2) Macro "code" con language=mermaid
    for macro in soup.find_all("ac:structured-macro", attrs={"ac:name": "code"}):
        params = {
            p.get("ac:name"): p.get_text()
            for p in macro.find_all("ac:parameter")
        }
        if params.get("language", "").lower() == "mermaid":
            body_tag = macro.find("ac:plain-text-body")
            if body_tag:
                return body_tag.get_text().strip()

    # 3) Buscar <pre> con contenido que empiece con "graph "
    for pre in soup.find_all("pre"):
        text = html.unescape(pre.get_text()).strip()
        if re.match(r"^(graph|flowchart|sequenceDiagram|classDiagram)\s", text):
            return text

    # 4) Regex fallback: bloque que empiece con graph TD/LR en cualquier lugar
    m = re.search(
        r"((?:graph|flowchart)\s+(?:TD|TB|LR|RL|BT)\b[\s\S]*?)(?=</|$)",
        storage_value,
    )
    if m:
        raw_code = html.unescape(m.group(1)).strip()
        raw_code = re.sub(r"<[^>]+>", "", raw_code)
        return raw_code

    return None


# ── Modelos ──────────────────────────────────────────────────────────────

class PageQuery(BaseModel):
    page_id: str | None = None
    title: str | None = None
    space_key: str | None = None


class PublishRequest(BaseModel):
    page_id: str
    mermaid_code: str
    section_title: str = "Flujo de negocio"


class SearchQuery(BaseModel):
    query: str
    space_key: str | None = None
    limit: int = 10


# ── Endpoints ────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "confluence_url": CONFLUENCE_BASE}


@app.post("/api/confluence/search")
def search_pages(q: SearchQuery):
    """Busca páginas en Confluence por texto o CQL."""
    cql = f'type=page AND text ~ "{q.query}"'
    if q.space_key:
        cql += f' AND space="{q.space_key}"'

    with _http_client() as client:
        resp = client.get(
            f"{CONFLUENCE_BASE}/rest/api/content/search",
            params={"cql": cql, "limit": q.limit},
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, resp.text)

    data = resp.json()
    results = []
    for r in data.get("results", []):
        results.append({
            "id": r["id"],
            "title": r["title"],
            "space": r.get("space", {}).get("key", ""),
            "url": CONFLUENCE_BASE + r.get("_links", {}).get("webui", ""),
        })
    return {"results": results}


@app.post("/api/confluence/get-page")
def get_page(q: PageQuery):
    """Obtiene una página y extrae el diagrama Mermaid si existe."""
    with _http_client() as client:
        if q.page_id:
            url = f"{CONFLUENCE_BASE}/rest/api/content/{q.page_id}"
            params = {"expand": "body.storage,version,space"}
            resp = client.get(url, params=params)
        elif q.title and q.space_key:
            url = f"{CONFLUENCE_BASE}/rest/api/content"
            params = {
                "title": q.title,
                "spaceKey": q.space_key,
                "expand": "body.storage,version,space",
            }
            resp = client.get(url, params=params)
        else:
            raise HTTPException(400, "Se requiere page_id o title+space_key")

    if resp.status_code != 200:
        raise HTTPException(resp.status_code, resp.text)

    data = resp.json()

    if "results" in data:
        if not data["results"]:
            raise HTTPException(404, "Página no encontrada")
        page = data["results"][0]
    else:
        page = data

    storage = page.get("body", {}).get("storage", {}).get("value", "")
    mermaid_code = extract_mermaid_from_storage(storage)
    version = page.get("version", {}).get("number", 1)

    return {
        "id": page["id"],
        "title": page["title"],
        "space": page.get("space", {}).get("key", ""),
        "version": version,
        "has_mermaid": mermaid_code is not None,
        "mermaid_code": mermaid_code,
        "url": CONFLUENCE_BASE + page.get("_links", {}).get("webui", ""),
    }


@app.post("/api/confluence/publish")
def publish_diagram(req: PublishRequest):
    """Publica/actualiza un diagrama Mermaid en una página de Confluence."""

    with _http_client() as client:
        # Obtener página actual
        resp = client.get(
            f"{CONFLUENCE_BASE}/rest/api/content/{req.page_id}",
            params={"expand": "body.storage,version,space"},
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, "No se pudo obtener la página")

    page = resp.json()
    current_content = page["body"]["storage"]["value"]
    current_version = page["version"]["number"]
    title = page["title"]
    space_key = page.get("space", {}).get("key", "")

    mermaid_macro = _build_mermaid_macro(req.mermaid_code)

    # Reemplazar macro HTML existente que contenga Mermaid, o insertar después del título de sección
    existing_macro_pattern = (
        r'<ac:structured-macro[^>]*ac:name="html"[^>]*>.*?</ac:structured-macro>'
    )
    if re.search(existing_macro_pattern, current_content, flags=re.DOTALL):
        new_content = re.sub(
            existing_macro_pattern, mermaid_macro, current_content,
            count=1, flags=re.DOTALL,
        )
    else:
        section_pattern = rf"(<h2>{re.escape(req.section_title)}</h2>)"
        if re.search(section_pattern, current_content):
            new_content = re.sub(
                section_pattern,
                rf"\1<p></p>{mermaid_macro}",
                current_content,
                count=1,
            )
        else:
            new_content = current_content + f"\n<h2>{req.section_title}</h2><p></p>{mermaid_macro}"

    body = {
        "version": {"number": current_version + 1},
        "title": title,
        "type": "page",
        "body": {
            "storage": {
                "value": new_content,
                "representation": "storage",
            }
        },
    }

    with _http_client() as client:
        resp = client.put(
            f"{CONFLUENCE_BASE}/rest/api/content/{req.page_id}",
            json=body,
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, resp.text)

    result = resp.json()
    return {
        "success": True,
        "version": result["version"]["number"],
        "url": CONFLUENCE_BASE + result.get("_links", {}).get("webui", ""),
    }


def _build_mermaid_macro(mermaid_code: str) -> str:
    return (
        '<ac:structured-macro ac:name="html" ac:schema-version="1">'
        "<ac:plain-text-body><![CDATA["
        '<!DOCTYPE html><html lang="es"><head>'
        '<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>'
        "<script>mermaid.initialize({ startOnLoad: true, theme: 'default', "
        "flowchart: { nodeSpacing: 25, rankSpacing: 35, curve: 'basis' } });</script>"
        "<style>"
        "body{font-family:'Segoe UI',sans-serif;background:#f8f9fa;display:flex;"
        "flex-direction:column;align-items:center;padding:20px;margin:0}"
        ".diagram-container{background:white;border-radius:16px;padding:32px;"
        "box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:1100px;overflow-x:auto}"
        "</style></head><body>"
        '<div class="diagram-container"><div class="mermaid">'
        f"{mermaid_code}"
        "</div></div></body></html>"
        "]]></ac:plain-text-body></ac:structured-macro>"
    )


# ── Documentador endpoints ────────────────────────────────────────────────

class DocPageRequest(BaseModel):
    url_or_id: str


class DocJiraRequest(BaseModel):
    keys: list[str]


def _extract_page_id_from_url(url_or_id: str) -> str:
    """Extrae el page ID de una URL de Confluence o devuelve el ID directo."""
    url_or_id = url_or_id.strip()
    if url_or_id.isdigit():
        return url_or_id
    m = re.search(r"/pages/(\d+)", url_or_id)
    if m:
        return m.group(1)
    m = re.search(r"pageId=(\d+)", url_or_id)
    if m:
        return m.group(1)
    return url_or_id


@app.post("/api/documentador/confluence-page")
def doc_get_confluence_page(req: DocPageRequest):
    """Lee una página de Confluence y devuelve su contenido en markdown y storage."""
    page_id = _extract_page_id_from_url(req.url_or_id)

    with _http_client() as client:
        resp = client.get(
            f"{CONFLUENCE_BASE}/rest/api/content/{page_id}",
            params={"expand": "body.storage,body.view,version,space,ancestors"},
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, f"No se pudo obtener la página: {resp.text}")

    page = resp.json()
    storage = page.get("body", {}).get("storage", {}).get("value", "")
    view_html = page.get("body", {}).get("view", {}).get("value", "")

    soup = BeautifulSoup(view_html or storage, "html.parser")
    text_content = soup.get_text(separator="\n", strip=True)

    sections = _extract_sections(storage)
    mermaid_code = extract_mermaid_from_storage(storage)

    return {
        "id": page["id"],
        "title": page["title"],
        "space": page.get("space", {}).get("key", ""),
        "version": page.get("version", {}).get("number", 1),
        "url": CONFLUENCE_BASE + page.get("_links", {}).get("webui", ""),
        "text_content": text_content[:8000],
        "sections": sections,
        "has_mermaid": mermaid_code is not None,
        "mermaid_code": mermaid_code,
    }


def _extract_sections(storage_html: str) -> list[dict]:
    """Extrae las secciones (h1, h2, h3) con su contenido resumido."""
    soup = BeautifulSoup(storage_html, "html.parser")
    sections = []
    current = None

    for el in soup.children:
        if not hasattr(el, "name") or el.name is None:
            continue
        if el.name in ("h1", "h2", "h3"):
            if current:
                sections.append(current)
            current = {
                "level": int(el.name[1]),
                "title": el.get_text(strip=True),
                "content": "",
            }
        elif current is not None:
            text = el.get_text(separator=" ", strip=True)
            if text and len(current["content"]) < 1500:
                current["content"] += text + "\n"

    if current:
        sections.append(current)

    return sections


@app.post("/api/documentador/jira-issues")
def doc_get_jira_issues(req: DocJiraRequest):
    """Lee múltiples issues de Jira por key y devuelve su info relevante."""
    if not req.keys:
        raise HTTPException(400, "Se requiere al menos una key de Jira")

    keys_str = ", ".join(f'"{k.strip()}"' for k in req.keys)
    jql = f"key in ({keys_str})"

    with _http_client() as client:
        resp = client.get(
            f"{CONFLUENCE_BASE.replace('/wiki', '')}/rest/api/2/search",
            params={
                "jql": jql,
                "maxResults": len(req.keys),
                "fields": "summary,description,status,issuetype,priority,assignee,labels,comment",
            },
        )

    if resp.status_code != 200:
        jira_base = CONFLUENCE_BASE.replace("/wiki", "")
        with _http_client() as client:
            resp = client.get(
                f"{jira_base}/rest/api/2/search",
                params={
                    "jql": jql,
                    "maxResults": len(req.keys),
                    "fields": "summary,description,status,issuetype,priority,assignee,labels",
                },
            )
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, f"Error buscando Jiras: {resp.text}")

    data = resp.json()
    issues = []

    for issue in data.get("issues", []):
        fields = issue.get("fields", {})
        desc_raw = fields.get("description") or ""
        if isinstance(desc_raw, dict):
            desc_text = _extract_adf_text(desc_raw)
        else:
            desc_soup = BeautifulSoup(str(desc_raw), "html.parser")
            desc_text = desc_soup.get_text(separator="\n", strip=True)

        issues.append({
            "key": issue["key"],
            "summary": fields.get("summary", ""),
            "description": desc_text[:3000],
            "status": fields.get("status", {}).get("name", ""),
            "type": fields.get("issuetype", {}).get("name", ""),
            "priority": fields.get("priority", {}).get("name", ""),
            "assignee": (fields.get("assignee") or {}).get("displayName", "Sin asignar"),
            "labels": fields.get("labels", []),
        })

    found_keys = {i["key"] for i in issues}
    not_found = [k for k in req.keys if k.strip() not in found_keys]

    return {
        "issues": issues,
        "total": len(issues),
        "not_found": not_found,
    }


def _extract_adf_text(adf: dict) -> str:
    """Extrae texto plano de Atlassian Document Format (ADF)."""
    texts = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "text":
                texts.append(node.get("text", ""))
            for child in node.get("content", []):
                walk(child)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(adf)
    return "\n".join(texts)


# ── Servir archivos estáticos del editor ─────────────────────────────────

static_dir = Path(__file__).parent
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8090, reload=True)
