/* ========================================
   Documentador - Application Logic
   ======================================== */

(function () {
    'use strict';

    const API = window.location.origin + '/api';

    let confluenceData = null;
    let jirasData = null;
    let generatedMermaid = '';

    // ── Parse Jira keys from textarea ──

    const jiraInput = document.getElementById('input-jira-keys');
    const jiraCount = document.getElementById('jira-count');

    function parseJiraKeys(text) {
        return text
            .split(/[\s,;]+/)
            .map(k => k.trim().toUpperCase())
            .filter(k => /^[A-Z][A-Z0-9]+-\d+$/.test(k));
    }

    jiraInput.addEventListener('input', () => {
        const keys = parseJiraKeys(jiraInput.value);
        jiraCount.textContent = keys.length;
    });

    // ── Process button ──

    document.getElementById('btn-process').addEventListener('click', () => {
        const urlOrId = document.getElementById('input-confluence-url').value.trim();
        const keys = parseJiraKeys(jiraInput.value);

        if (!urlOrId) { showToast('Ingresá el link o ID de la página de Confluence'); return; }
        if (keys.length === 0) { showToast('Ingresá al menos una key de Jira'); return; }

        runProcess(urlOrId, keys);
    });

    // ── Main orchestration ──

    async function runProcess(urlOrId, jiraKeys) {
        const btn = document.getElementById('btn-process');
        btn.disabled = true;

        showPanel('progress');
        clearLog();
        setProgress(0);

        const totalSteps = 2 + jiraKeys.length + 1;
        let currentStep = 0;

        function advance(msg, type) {
            currentStep++;
            setProgress((currentStep / totalSteps) * 100);
            addLog(msg, type);
        }

        try {
            // Step 1: Leer página base de Confluence
            addLog('Leyendo página base de Confluence...', 'loading');
            const confResp = await fetch(API + '/documentador/confluence-page', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url_or_id: urlOrId }),
            });

            if (!confResp.ok) {
                const err = await confResp.json().catch(() => ({ detail: confResp.statusText }));
                throw new Error(`Confluence: ${err.detail || 'Error desconocido'}`);
            }

            confluenceData = await confResp.json();
            advance(`Página "${confluenceData.title}" cargada (v${confluenceData.version})`, 'success');

            // Step 2: Leer Jiras
            addLog(`Leyendo ${jiraKeys.length} issues de Jira...`, 'loading');
            const jiraResp = await fetch(API + '/documentador/jira-issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys: jiraKeys }),
            });

            if (!jiraResp.ok) {
                const err = await jiraResp.json().catch(() => ({ detail: jiraResp.statusText }));
                throw new Error(`Jira: ${err.detail || 'Error desconocido'}`);
            }

            jirasData = await jiraResp.json();
            advance(`${jirasData.total} issues cargados`, 'success');

            if (jirasData.not_found.length > 0) {
                addLog(`No encontradas: ${jirasData.not_found.join(', ')}`, 'error');
            }

            // Step 3: Procesar cada Jira
            for (const issue of jirasData.issues) {
                advance(`${issue.key}: ${issue.summary}`, 'info');
            }

            // Step 4: Generar diagrama
            addLog('Generando diagrama de flujo...', 'loading');
            generatedMermaid = buildMermaidFromData(confluenceData, jirasData.issues);
            advance('Diagrama generado', 'success');

            // Render results
            renderResults();
            showPanel('result');

        } catch (err) {
            addLog('Error: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
        }
    }

    // ── Build Mermaid diagram from extracted data ──

    function buildMermaidFromData(confData, issues) {
        const lines = [];
        lines.push('graph TD');
        lines.push('');
        lines.push('    %% Definición de estilos');
        lines.push('    classDef srv fill:#E6F3FF,stroke:#00008B,stroke-width:2px;');
        lines.push('    classDef paso fill:#FFF5E6,stroke:#FF8C00,stroke-width:2px;');
        lines.push('    classDef err fill:#F3E6FF,stroke:#8A2BE2,stroke-width:2px;');
        lines.push('    classDef sub fill:#E6FFE6,stroke:#006400,stroke-width:2px;');
        lines.push('    classDef decision fill:#FFFFFF,stroke:#000000,stroke-width:2px;');
        lines.push('');

        const nodeMap = {};
        const edgeList = [];
        let nodeCounter = 0;

        function addNode(label, type) {
            const cleanLabel = label.replace(/"/g, "'");
            const key = cleanLabel.toLowerCase();
            if (nodeMap[key]) return nodeMap[key].id;
            const id = 'N' + (++nodeCounter);
            nodeMap[key] = { id, label: cleanLabel, type };
            return id;
        }

        // Start node
        const startId = addNode('Inicio', 'decision');

        // Extract flow from Confluence sections
        let prevId = startId;
        const confSections = confData.sections || [];
        for (const section of confSections) {
            const title = section.title.trim();
            if (!title || /^(revisiones|métricas|pruebas|monitoreo|restricciones)/i.test(title)) continue;
            if (/^(descripción|ámbito|referencia|pre-condicion|post-condicion)/i.test(title)) continue;

            const content = section.content || '';
            const tasks = extractTasksFromText(title, content);

            for (const task of tasks) {
                const nodeId = addNode(task.label, task.type);
                edgeList.push({ from: prevId, to: nodeId, label: '' });
                prevId = nodeId;
            }
        }

        // Enrich with Jira issues
        for (const issue of issues) {
            const desc = issue.description || '';
            const summary = issue.summary || '';
            const tasks = extractTasksFromText(summary, desc);

            if (tasks.length === 0) {
                const type = guessTypeFromText(summary);
                const label = type === 'srv' ? `srv.${summary}` :
                              type === 'paso' ? `paso.${summary}` :
                              type === 'err' ? `err.${summary}` :
                              type === 'sub' ? `sub.${summary}` : `paso.${summary}`;
                tasks.push({ label, type });
            }

            for (const task of tasks) {
                const nodeId = addNode(task.label, task.type);
                if (!edgeList.some(e => e.to === nodeId)) {
                    edgeList.push({ from: prevId, to: nodeId, label: '' });
                    prevId = nodeId;
                }
            }
        }

        // End node
        const endId = addNode('Fin', 'end');
        edgeList.push({ from: prevId, to: endId, label: '' });

        // Write nodes
        lines.push('    %% Nodos');
        for (const [, node] of Object.entries(nodeMap)) {
            if (node.label === 'Inicio' || node.label === 'Fin') {
                lines.push(`    ${node.id}(("${node.label}"))`);
            } else if (node.type === 'decision') {
                lines.push(`    ${node.id}{"${node.label}"}`);
            } else if (node.type === 'sub') {
                lines.push(`    ${node.id}[["${node.label}"]]`);
            } else {
                lines.push(`    ${node.id}["${node.label}"]`);
            }
        }

        lines.push('');
        lines.push('    %% Conexiones');
        for (const edge of edgeList) {
            if (edge.label) {
                lines.push(`    ${edge.from} -->|${edge.label}| ${edge.to}`);
            } else {
                lines.push(`    ${edge.from} --> ${edge.to}`);
            }
        }

        // Class assignments
        const groups = {};
        for (const [, node] of Object.entries(nodeMap)) {
            const cls = node.type === 'end' ? 'decision' : node.type;
            if (!groups[cls]) groups[cls] = [];
            groups[cls].push(node.id);
        }
        lines.push('');
        lines.push('    %% Asignación de clases');
        for (const [cls, ids] of Object.entries(groups)) {
            lines.push(`    class ${ids.join(',')} ${cls};`);
        }

        return lines.join('\n');
    }

    function extractTasksFromText(title, content) {
        const tasks = [];
        const combined = (title + ' ' + content).toLowerCase();
        const sentences = content.split(/[.\n]/).map(s => s.trim()).filter(s => s.length > 5);

        for (const sentence of sentences) {
            const lower = sentence.toLowerCase();

            if (/\b(api|servicio|service|consulta|validar|validación|obtener|enviar|generar|calcular|procesar|ejecutar|recuperar|autenticar)\b/i.test(sentence)) {
                const label = 'srv.' + capitalize(sentence.substring(0, 60));
                tasks.push({ label, type: 'srv' });
            } else if (/\b(pantalla|mostrar|display|usuario|seleccionar|click|botón|formulario|ingresar|confirmar|visualizar)\b/i.test(sentence)) {
                const label = 'paso.' + capitalize(sentence.substring(0, 60));
                tasks.push({ label, type: 'paso' });
            } else if (/\b(error|excepción|fallo|rechaz|timeout|invalido|inválido)\b/i.test(sentence)) {
                const label = 'err.' + capitalize(sentence.substring(0, 60));
                tasks.push({ label, type: 'err' });
            } else if (/\b(sub-?flujo|redirect|redirigir|navegar a|ir a|chk\.|pre\.|derivar)\b/i.test(sentence)) {
                const label = 'sub.' + capitalize(sentence.substring(0, 60));
                tasks.push({ label, type: 'sub' });
            }

            if (tasks.length >= 5) break;
        }

        if (tasks.length === 0 && title) {
            const type = guessTypeFromText(title);
            const prefix = { srv: 'srv.', paso: 'paso.', err: 'err.', sub: 'sub.', decision: '' }[type] || 'paso.';
            tasks.push({ label: prefix + capitalize(title.substring(0, 60)), type });
        }

        return tasks;
    }

    function guessTypeFromText(text) {
        const lower = text.toLowerCase();
        if (/\b(api|servicio|service|consulta|validar|obtener|enviar|generar|calcular|procesar|recuperar)\b/.test(lower)) return 'srv';
        if (/\b(error|excepción|fallo|rechaz|timeout)\b/.test(lower)) return 'err';
        if (/\b(sub-?flujo|redirect|redirigir|chk\.|pre\.)\b/.test(lower)) return 'sub';
        if (/\b(condición|decisión|si\b|no\b|\?)/i.test(lower)) return 'decision';
        return 'paso';
    }

    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // ── Render final results ──

    function renderResults() {
        // Title
        document.getElementById('result-title').textContent =
            `Documentación: ${confluenceData.title}`;

        // Summary
        const summaryEl = document.getElementById('summary-content');
        summaryEl.innerHTML = `
            <h4>Fuentes procesadas</h4>
            <ul>
                <li><strong>Página base:</strong> ${esc(confluenceData.title)} (${confluenceData.space})</li>
                <li><strong>Issues Jira:</strong> ${jirasData.total} procesadas</li>
                ${jirasData.not_found.length > 0 ? `<li><strong>No encontradas:</strong> ${esc(jirasData.not_found.join(', '))}</li>` : ''}
            </ul>
            <h4>Secciones de la ESRE</h4>
            <ul>
                ${(confluenceData.sections || []).map(s =>
                    `<li>${'—'.repeat(s.level - 1)} ${esc(s.title)}</li>`
                ).join('')}
            </ul>
        `;

        // Confluence content
        document.getElementById('confluence-link').href = confluenceData.url;
        const confEl = document.getElementById('confluence-content');
        const textPreview = (confluenceData.text_content || '').substring(0, 2000);
        confEl.innerHTML = `<p>${esc(textPreview).replace(/\n/g, '<br>')}</p>`;

        // Jiras
        const jirasEl = document.getElementById('jiras-content');
        jirasEl.innerHTML = jirasData.issues.map(issue => {
            const statusClass = /done|cerra|termin/i.test(issue.status) ? 'done' :
                                /progress|curso/i.test(issue.status) ? 'progress' : 'todo';
            return `
                <div class="jira-item">
                    <div class="jira-item-header">
                        <span class="jira-key">${esc(issue.key)}</span>
                        <span class="jira-status jira-status--${statusClass}">${esc(issue.status)}</span>
                        <span style="font-size:11px;color:var(--color-text-secondary)">${esc(issue.type)}</span>
                    </div>
                    <div class="jira-summary">${esc(issue.summary)}</div>
                    ${issue.description ? `<div class="jira-desc">${esc(issue.description.substring(0, 500))}</div>` : ''}
                </div>
            `;
        }).join('');

        // Diagram
        renderDiagram();
    }

    async function renderDiagram() {
        const container = document.getElementById('diagram-container');
        const codeEl = document.getElementById('diagram-code');
        codeEl.textContent = generatedMermaid;

        try {
            mermaid.initialize({ startOnLoad: false, theme: 'default' });
            const { svg } = await mermaid.render('doc-diagram-' + Date.now(), generatedMermaid);
            container.innerHTML = svg;
        } catch (err) {
            container.innerHTML = `
                <p style="color:#c00;font-family:sans-serif;">Error renderizando diagrama:</p>
                <pre style="color:#c00;white-space:pre-wrap;font-size:13px;">${esc(err.message)}</pre>
            `;
        }
    }

    // ── Open in Graficador ──

    document.getElementById('btn-open-in-editor').addEventListener('click', () => {
        if (!generatedMermaid) { showToast('No hay diagrama generado'); return; }
        sessionStorage.setItem('importMermaid', generatedMermaid);
        window.open('/editor.html?import=session', '_blank');
    });

    // ── Copy document ──

    document.getElementById('btn-copy-doc').addEventListener('click', () => {
        if (!confluenceData) return;

        let doc = `# ${confluenceData.title}\n\n`;
        doc += `## Fuente: ${confluenceData.url}\n\n`;
        doc += `## Contenido Base\n${confluenceData.text_content}\n\n`;
        doc += `## Issues de Jira\n\n`;
        for (const issue of jirasData.issues) {
            doc += `### ${issue.key} - ${issue.summary}\n`;
            doc += `Estado: ${issue.status} | Tipo: ${issue.type}\n`;
            if (issue.description) doc += `${issue.description}\n`;
            doc += '\n';
        }
        doc += `## Diagrama de Flujo (Mermaid)\n\n\`\`\`mermaid\n${generatedMermaid}\n\`\`\`\n`;

        navigator.clipboard.writeText(doc).then(() => showToast('Documento copiado al portapapeles'));
    });

    // ── Download HTML ──

    document.getElementById('btn-download-doc').addEventListener('click', () => {
        if (!confluenceData) return;

        const htmlDoc = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>${esc(confluenceData.title)} - Documentación</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"><\/script>
    <script>mermaid.initialize({ startOnLoad: true });<\/script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; max-width: 960px; margin: 0 auto; padding: 40px; background: #f8f9fa; color: #1a1a2e; }
        h1 { color: #1a3a5c; border-bottom: 2px solid #e0e0e0; padding-bottom: 12px; }
        h2 { color: #2d4a6f; margin-top: 32px; }
        h3 { color: #3d5a80; }
        .jira-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin: 12px 0; background: #fff; }
        .jira-key { font-family: monospace; font-weight: bold; color: #0052CC; }
        .jira-status { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; background: #e0e7ff; color: #3730a3; }
        .mermaid { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        pre { background: #f1f3f5; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
    </style>
</head>
<body>
    <h1>${esc(confluenceData.title)}</h1>
    <p><em>Generado desde Confluence + Jira</em></p>

    <h2>Diagrama de Flujo</h2>
    <div class="mermaid">
${generatedMermaid}
    </div>

    <h2>Contenido Base (ESRE)</h2>
    <p>${esc(confluenceData.text_content || '').replace(/\n/g, '<br>')}</p>

    <h2>Issues de Jira</h2>
    ${jirasData.issues.map(issue => `
    <div class="jira-card">
        <span class="jira-key">${esc(issue.key)}</span>
        <span class="jira-status">${esc(issue.status)}</span>
        <h3>${esc(issue.summary)}</h3>
        ${issue.description ? `<p>${esc(issue.description.substring(0, 800)).replace(/\n/g, '<br>')}</p>` : ''}
    </div>`).join('')}
</body>
</html>`;

        const blob = new Blob([htmlDoc], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `documentacion-${confluenceData.title.replace(/[^a-zA-Z0-9]/g, '_')}.html`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('HTML descargado');
    });

    // ── UI helpers ──

    function showPanel(name) {
        document.getElementById('doc-empty').style.display = name === 'empty' ? 'flex' : 'none';
        document.getElementById('doc-progress').style.display = name === 'progress' ? 'block' : 'none';
        document.getElementById('doc-result').style.display = name === 'result' ? 'block' : 'none';
    }

    function setProgress(pct) {
        document.getElementById('progress-bar').style.width = Math.min(100, pct) + '%';
    }

    function clearLog() {
        document.getElementById('progress-log').innerHTML = '';
    }

    function addLog(msg, type) {
        const log = document.getElementById('progress-log');
        const entry = document.createElement('div');
        entry.className = `doc-log-entry doc-log-entry--${type}`;

        const icon = type === 'loading'
            ? '<div class="doc-log-spinner"></div>'
            : type === 'success' ? '<span>✓</span>'
            : type === 'error' ? '<span>✗</span>'
            : '<span>→</span>';

        entry.innerHTML = `${icon}<span>${esc(msg)}</span>`;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;

        if (type !== 'loading') {
            const loadingEntries = log.querySelectorAll('.doc-log-entry--loading');
            if (loadingEntries.length > 0) {
                const last = loadingEntries[loadingEntries.length - 1];
                last.remove();
            }
        }
    }

    function showToast(msg) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function esc(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

})();
