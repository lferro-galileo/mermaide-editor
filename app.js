/* ========================================
   Mermaid Flow Editor - Application Logic
   ======================================== */

(function () {
    'use strict';

    const NODE_DEFAULTS = {
        start:    { prefix: '',     label: 'Inicio',              className: 'canvas-node--start' },
        end:      { prefix: '',     label: 'Fin',                 className: 'canvas-node--end' },
        srv:      { prefix: 'srv.', label: 'Nombre Servicio',     className: 'canvas-node--srv' },
        paso:     { prefix: 'paso.', label: 'Nombre Paso',        className: 'canvas-node--paso' },
        err:      { prefix: 'err.', label: 'Nombre Error',        className: 'canvas-node--err' },
        sub:      { prefix: 'sub.', label: 'Nombre Subflujo',     className: 'canvas-node--sub' },
        decision: { prefix: '',     label: '¿Condición?',         className: 'canvas-node--decision' },
    };

    let nodes = [];
    let edges = [];
    let nodeIdCounter = 0;
    let edgeIdCounter = 0;

    let connectMode = false;
    let connectSource = null;
    let tempLine = null;
    let draggingNode = null;
    let dragOffset = { x: 0, y: 0 };
    let editingNodeId = null;
    let editingEdgeId = null;

    const canvas = document.getElementById('canvas');
    const canvasContainer = document.getElementById('canvas-container');
    const svgLayer = document.getElementById('connections-layer');
    const placeholder = document.getElementById('canvas-placeholder');

    // SVG arrow marker
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#8b8fa8"/>
        </marker>
        <marker id="arrowhead-hover" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#22d3ee"/>
        </marker>
    `;
    svgLayer.appendChild(defs);

    // ─── Drag from sidebar ───

    document.querySelectorAll('.draggable-element').forEach(el => {
        el.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', el.dataset.type);
            e.dataTransfer.effectAllowed = 'copy';
        });
    });

    canvas.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    canvas.addEventListener('drop', e => {
        e.preventDefault();
        const type = e.dataTransfer.getData('text/plain');
        if (!type || !NODE_DEFAULTS[type]) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left + canvasContainer.scrollLeft;
        const y = e.clientY - rect.top + canvasContainer.scrollTop;

        addNode(type, x, y);
    });

    // ─── Node creation ───

    function addNode(type, x, y) {
        const id = 'n' + (++nodeIdCounter);
        const defaults = NODE_DEFAULTS[type];
        const name = defaults.prefix + defaults.label;

        const node = { id, type, name, x, y };
        nodes.push(node);

        renderNode(node);
        updatePlaceholder();
    }

    function renderNode(node) {
        const el = document.createElement('div');
        el.className = `canvas-node ${NODE_DEFAULTS[node.type].className}`;
        el.id = node.id;
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
        el.textContent = node.name;

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'node-delete-btn';
        deleteBtn.innerHTML = '&times;';
        deleteBtn.addEventListener('click', e => {
            e.stopPropagation();
            removeNode(node.id);
        });
        el.appendChild(deleteBtn);

        // Double click to edit
        el.addEventListener('dblclick', e => {
            e.stopPropagation();
            openEditModal(node.id);
        });

        // Mouse down for dragging or connecting
        el.addEventListener('mousedown', e => {
            if (e.target === deleteBtn) return;
            e.preventDefault();

            if (connectMode) {
                handleConnectClick(node.id, el);
                return;
            }

            const rect = el.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            draggingNode = node;
            el.style.zIndex = 50;
        });

        canvas.appendChild(el);
    }

    // ─── Node dragging ───

    document.addEventListener('mousemove', e => {
        if (draggingNode) {
            const rect = canvas.getBoundingClientRect();
            let newX = e.clientX - rect.left + canvasContainer.scrollLeft - dragOffset.x;
            let newY = e.clientY - rect.top + canvasContainer.scrollTop - dragOffset.y;

            newX = Math.max(0, newX);
            newY = Math.max(0, newY);

            draggingNode.x = newX;
            draggingNode.y = newY;

            const el = document.getElementById(draggingNode.id);
            el.style.left = newX + 'px';
            el.style.top = newY + 'px';

            updateAllEdges();
        }

        if (connectSource && tempLine) {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left + canvasContainer.scrollLeft;
            const my = e.clientY - rect.top + canvasContainer.scrollTop;
            const sourceEl = document.getElementById(connectSource);
            const sc = getNodeCenter(sourceEl);
            tempLine.setAttribute('x1', sc.x);
            tempLine.setAttribute('y1', sc.y);
            tempLine.setAttribute('x2', mx);
            tempLine.setAttribute('y2', my);
        }
    });

    document.addEventListener('mouseup', () => {
        if (draggingNode) {
            const el = document.getElementById(draggingNode.id);
            if (el) el.style.zIndex = 10;
            draggingNode = null;
        }
    });

    // ─── Connections ───

    const connectBtn = document.getElementById('btn-connect');
    const connectHint = document.getElementById('connect-hint');

    connectBtn.addEventListener('click', () => {
        connectMode = !connectMode;
        connectBtn.classList.toggle('active', connectMode);
        connectHint.style.display = connectMode ? 'block' : 'none';
        cancelConnection();
    });

    function handleConnectClick(nodeId, el) {
        if (!connectSource) {
            connectSource = nodeId;
            el.classList.add('connect-source');

            tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            tempLine.classList.add('temp-connection');
            const c = getNodeCenter(el);
            tempLine.setAttribute('x1', c.x);
            tempLine.setAttribute('y1', c.y);
            tempLine.setAttribute('x2', c.x);
            tempLine.setAttribute('y2', c.y);
            svgLayer.appendChild(tempLine);
        } else if (connectSource !== nodeId) {
            const existing = edges.find(e => e.from === connectSource && e.to === nodeId);
            if (!existing) {
                addEdge(connectSource, nodeId);
            }
            cancelConnection();
        } else {
            cancelConnection();
        }
    }

    function cancelConnection() {
        if (connectSource) {
            const el = document.getElementById(connectSource);
            if (el) el.classList.remove('connect-source');
        }
        connectSource = null;
        if (tempLine) {
            tempLine.remove();
            tempLine = null;
        }
    }

    canvas.addEventListener('click', e => {
        if (e.target === canvas && connectSource) {
            cancelConnection();
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            cancelConnection();
            connectMode = false;
            connectBtn.classList.remove('active');
            connectHint.style.display = 'none';
        }
    });

    function addEdge(fromId, toId, label = '') {
        const id = 'e' + (++edgeIdCounter);
        const edge = { id, from: fromId, to: toId, label };
        edges.push(edge);
        renderEdge(edge);
    }

    function renderEdge(edge) {
        const fromEl = document.getElementById(edge.from);
        const toEl = document.getElementById(edge.to);
        if (!fromEl || !toEl) return;

        const fromC = getNodeCenter(fromEl);
        const toC = getNodeCenter(toEl);

        const fromPort = getEdgePort(fromEl, fromC, toC);
        const toPort = getEdgePort(toEl, toC, fromC);

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.id = edge.id;
        group.dataset.edgeId = edge.id;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const d = buildCurvePath(fromPort, toPort);
        path.setAttribute('d', d);
        path.classList.add('connection-line');
        path.style.pointerEvents = 'stroke';

        // Click zone (wider invisible path for easier clicking)
        const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitArea.setAttribute('d', d);
        hitArea.setAttribute('stroke', 'transparent');
        hitArea.setAttribute('stroke-width', '16');
        hitArea.setAttribute('fill', 'none');
        hitArea.style.pointerEvents = 'stroke';
        hitArea.style.cursor = 'pointer';

        const onEdgeClick = (e) => {
            e.stopPropagation();
            openEdgeModal(edge.id);
        };
        hitArea.addEventListener('click', onEdgeClick);
        path.addEventListener('click', onEdgeClick);

        group.appendChild(hitArea);
        group.appendChild(path);

        if (edge.label) {
            const midX = (fromPort.x + toPort.x) / 2;
            const midY = (fromPort.y + toPort.y) / 2;

            const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            bg.classList.add('connection-label-bg');
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.classList.add('connection-label');
            text.setAttribute('x', midX);
            text.setAttribute('y', midY + 4);
            text.setAttribute('text-anchor', 'middle');
            text.textContent = edge.label;

            const textLen = edge.label.length * 7 + 12;
            bg.setAttribute('x', midX - textLen / 2);
            bg.setAttribute('y', midY - 10);
            bg.setAttribute('width', textLen);
            bg.setAttribute('height', 20);

            bg.addEventListener('click', onEdgeClick);
            text.addEventListener('click', onEdgeClick);

            group.appendChild(bg);
            group.appendChild(text);
        }

        svgLayer.appendChild(group);
    }

    function buildCurvePath(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const curvature = Math.min(dist * 0.3, 80);

        const cx1 = from.x + (dx > 0 ? curvature : -curvature);
        const cy1 = from.y;
        const cx2 = to.x - (dx > 0 ? curvature : -curvature);
        const cy2 = to.y;

        return `M ${from.x} ${from.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${to.x} ${to.y}`;
    }

    function updateAllEdges() {
        edges.forEach(edge => {
            const group = document.getElementById(edge.id);
            if (group) group.remove();
            renderEdge(edge);
        });
    }

    function getNodeCenter(el) {
        return {
            x: el.offsetLeft + el.offsetWidth / 2,
            y: el.offsetTop + el.offsetHeight / 2,
        };
    }

    function getEdgePort(nodeEl, nodeCenter, otherCenter) {
        const w = nodeEl.offsetWidth / 2;
        const h = nodeEl.offsetHeight / 2;
        const dx = otherCenter.x - nodeCenter.x;
        const dy = otherCenter.y - nodeCenter.y;
        const angle = Math.atan2(dy, dx);

        const absCos = Math.abs(Math.cos(angle));
        const absSin = Math.abs(Math.sin(angle));

        let px, py;
        if (w * absSin <= h * absCos) {
            const sign = dx > 0 ? 1 : -1;
            px = nodeCenter.x + sign * w;
            py = nodeCenter.y + (w * Math.tan(angle)) * sign;
        } else {
            const sign = dy > 0 ? 1 : -1;
            px = nodeCenter.x + (h / Math.tan(angle)) * sign;
            py = nodeCenter.y + sign * h;
        }

        return { x: px, y: py };
    }

    // ─── Remove node ───

    function removeNode(nodeId) {
        nodes = nodes.filter(n => n.id !== nodeId);
        edges = edges.filter(e => {
            if (e.from === nodeId || e.to === nodeId) {
                const g = document.getElementById(e.id);
                if (g) g.remove();
                return false;
            }
            return true;
        });
        const el = document.getElementById(nodeId);
        if (el) el.remove();
        updatePlaceholder();
    }

    // ─── Edit node modal ───

    function openEditModal(nodeId) {
        editingNodeId = nodeId;
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;

        document.getElementById('edit-node-name').value = node.name;
        document.getElementById('modal-edit').style.display = 'flex';
        document.getElementById('edit-node-name').focus();
    }

    document.getElementById('modal-edit-save').addEventListener('click', () => {
        if (!editingNodeId) return;
        const node = nodes.find(n => n.id === editingNodeId);
        if (!node) return;
        const newName = document.getElementById('edit-node-name').value.trim();
        if (newName) {
            node.name = newName;
            const el = document.getElementById(editingNodeId);
            if (el) {
                // Preserve delete button
                const del = el.querySelector('.node-delete-btn');
                el.textContent = newName;
                el.appendChild(del);
            }
        }
        document.getElementById('modal-edit').style.display = 'none';
        editingNodeId = null;
    });

    document.getElementById('modal-edit-delete').addEventListener('click', () => {
        if (editingNodeId) removeNode(editingNodeId);
        document.getElementById('modal-edit').style.display = 'none';
        editingNodeId = null;
    });

    document.getElementById('modal-edit-close').addEventListener('click', () => {
        document.getElementById('modal-edit').style.display = 'none';
        editingNodeId = null;
    });

    // ─── Edit edge modal ───

    function openEdgeModal(edgeId) {
        editingEdgeId = edgeId;
        const edge = edges.find(e => e.id === edgeId);
        if (!edge) return;

        document.getElementById('edit-edge-label').value = edge.label || '';
        document.getElementById('modal-edge').style.display = 'flex';
        document.getElementById('edit-edge-label').focus();
    }

    document.getElementById('modal-edge-save').addEventListener('click', () => {
        if (!editingEdgeId) return;
        const edge = edges.find(e => e.id === editingEdgeId);
        if (!edge) return;
        edge.label = document.getElementById('edit-edge-label').value.trim();
        updateAllEdges();
        document.getElementById('modal-edge').style.display = 'none';
        editingEdgeId = null;
    });

    document.getElementById('modal-edge-delete').addEventListener('click', () => {
        if (editingEdgeId) {
            const g = document.getElementById(editingEdgeId);
            if (g) g.remove();
            edges = edges.filter(e => e.id !== editingEdgeId);
        }
        document.getElementById('modal-edge').style.display = 'none';
        editingEdgeId = null;
    });

    document.getElementById('modal-edge-close').addEventListener('click', () => {
        document.getElementById('modal-edge').style.display = 'none';
        editingEdgeId = null;
    });

    // ─── Generate Mermaid code ───

    document.getElementById('btn-generate').addEventListener('click', () => {
        const code = generateMermaidCode();
        document.getElementById('generated-code').textContent = code;
        document.getElementById('modal-code').style.display = 'flex';
    });

    document.getElementById('modal-code-close').addEventListener('click', () => {
        document.getElementById('modal-code').style.display = 'none';
    });

    function generateMermaidCode() {
        if (nodes.length === 0) return '%% No hay nodos en el diagrama';

        let lines = [];
        lines.push('graph TD');
        lines.push('');
        lines.push('    %% Definición de estilos');
        lines.push('    classDef srv fill:#E6F3FF,stroke:#00008B,stroke-width:2px;');
        lines.push('    classDef paso fill:#FFF5E6,stroke:#FF8C00,stroke-width:2px;');
        lines.push('    classDef err fill:#F3E6FF,stroke:#8A2BE2,stroke-width:2px;');
        lines.push('    classDef sub fill:#E6FFE6,stroke:#006400,stroke-width:2px;');
        lines.push('    classDef decision fill:#FFFFFF,stroke:#000000,stroke-width:2px;');
        lines.push('    classDef fin fill:#FFFFFF,stroke:#000000,stroke-width:4px,font-weight:bold;');
        lines.push('');
        lines.push('    %% Nodos');

        const nodeIdMap = {};
        nodes.forEach((node, i) => {
            const mermaidId = sanitizeId(node.id);
            nodeIdMap[node.id] = mermaidId;

            const label = escapeLabel(node.name);

            let nodeDef;
            if (node.type === 'start' || node.type === 'end') {
                nodeDef = `    ${mermaidId}(("${label}"))`;
            } else if (node.type === 'decision') {
                nodeDef = `    ${mermaidId}{"${label}"}`;
            } else if (node.type === 'sub') {
                nodeDef = `    ${mermaidId}[["${label}"]]`;
            } else {
                nodeDef = `    ${mermaidId}["${label}"]`;
            }
            lines.push(nodeDef);
        });

        lines.push('');
        lines.push('    %% Conexiones');

        edges.forEach(edge => {
            const fromId = nodeIdMap[edge.from];
            const toId = nodeIdMap[edge.to];
            if (!fromId || !toId) return;

            if (edge.label) {
                lines.push(`    ${fromId} -->|${escapeLabel(edge.label)}| ${toId}`);
            } else {
                lines.push(`    ${fromId} --> ${toId}`);
            }
        });

        // Class assignments
        const typeGroups = {};
        nodes.forEach(node => {
            const classType = getClassType(node.type);
            if (!typeGroups[classType]) typeGroups[classType] = [];
            typeGroups[classType].push(nodeIdMap[node.id]);
        });

        lines.push('');
        lines.push('    %% Asignación de clases');
        for (const [cls, ids] of Object.entries(typeGroups)) {
            lines.push(`    class ${ids.join(',')} ${cls};`);
        }

        return lines.join('\n');
    }

    function sanitizeId(id) {
        return id.replace(/[^a-zA-Z0-9]/g, '_');
    }

    function escapeLabel(text) {
        return text.replace(/"/g, "'");
    }

    function getClassType(type) {
        if (type === 'start' || type === 'decision') return 'decision';
        if (type === 'end') return 'fin';
        return type;
    }

    // ─── Copy code ───

    document.getElementById('btn-copy-code').addEventListener('click', () => {
        const code = document.getElementById('generated-code').textContent;
        navigator.clipboard.writeText(code).then(() => {
            showToast('Código copiado al portapapeles');
        });
    });

    // ─── Download HTML ───

    document.getElementById('btn-download-html').addEventListener('click', () => {
        const mermaidCode = document.getElementById('generated-code').textContent;
        const html = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Diagrama de Flujo</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"><\/script>
    <script>
        mermaid.initialize({ startOnLoad: true });
    <\/script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; padding: 40px; background: #f8f9fa; }
        h1 { color: #333; margin-bottom: 24px; }
        .mermaid { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    </style>
</head>
<body>
    <h1>Diagrama Generado</h1>
    <div class="mermaid">
${mermaidCode}
    </div>
</body>
</html>`;

        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diagrama.html';
        a.click();
        URL.revokeObjectURL(url);
        showToast('HTML descargado');
    });

    // ─── Preview ───

    let previewCounter = 0;

    document.getElementById('btn-preview').addEventListener('click', async () => {
        const code = generateMermaidCode();
        if (nodes.length === 0) {
            showToast('No hay nodos para previsualizar');
            return;
        }

        const container = document.getElementById('preview-container');
        container.innerHTML = '';
        document.getElementById('modal-preview').style.display = 'flex';

        const uniqueId = 'preview-diagram-' + (++previewCounter);

        try {
            const { svg } = await mermaid.render(uniqueId, code);
            container.innerHTML = svg;
        } catch (err) {
            container.innerHTML = `<p style="color:#c00; font-family: sans-serif;">Error renderizando el diagrama:</p>
                <pre style="color:#c00; white-space:pre-wrap; font-size:13px;">${err.message}</pre>
                <hr style="margin:12px 0;">
                <pre style="font-size:12px; white-space:pre-wrap;">${code}</pre>`;
            const errorSvg = document.getElementById('d' + uniqueId);
            if (errorSvg) errorSvg.remove();
        }
    });

    document.getElementById('modal-preview-close').addEventListener('click', () => {
        document.getElementById('modal-preview').style.display = 'none';
    });

    // ─── Clear canvas ───

    document.getElementById('btn-clear').addEventListener('click', () => {
        if (nodes.length === 0) return;
        if (!confirm('¿Limpiar todo el canvas?')) return;
        clearCanvas();
        updatePlaceholder();
    });

    // ─── Helpers ───

    function updatePlaceholder() {
        placeholder.style.display = nodes.length === 0 ? 'flex' : 'none';
    }

    function showToast(msg) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) {
                overlay.style.display = 'none';
                editingNodeId = null;
                editingEdgeId = null;
            }
        });
    });

    // Enter key on modal inputs
    document.getElementById('edit-node-name').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('modal-edit-save').click();
    });
    document.getElementById('edit-edge-label').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('modal-edge-save').click();
    });

    // ─── Import Mermaid code ───

    document.getElementById('btn-import').addEventListener('click', () => {
        document.getElementById('import-code').value = '';
        document.getElementById('modal-import').style.display = 'flex';
        document.getElementById('import-code').focus();
    });

    document.getElementById('modal-import-close').addEventListener('click', () => {
        document.getElementById('modal-import').style.display = 'none';
    });

    document.getElementById('modal-import-cancel').addEventListener('click', () => {
        document.getElementById('modal-import').style.display = 'none';
    });

    document.getElementById('modal-import-apply').addEventListener('click', () => {
        const code = document.getElementById('import-code').value.trim();
        if (!code) {
            showToast('No hay código para importar');
            return;
        }

        try {
            importMermaidCode(code);
            document.getElementById('modal-import').style.display = 'none';
            showToast('Diagrama importado correctamente');
        } catch (err) {
            showToast('Error al parsear: ' + err.message);
        }
    });

    function clearCanvas() {
        nodes.forEach(n => {
            const el = document.getElementById(n.id);
            if (el) el.remove();
        });
        edges.forEach(e => {
            const g = document.getElementById(e.id);
            if (g) g.remove();
        });
        nodes = [];
        edges = [];
    }

    function importMermaidCode(code) {
        const lines = code.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('%%'));

        const parsedNodes = {};
        const parsedEdges = [];
        const classAssignments = {};

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (/^graph\s+(TD|TB|LR|RL|BT)/i.test(line)) continue;
            if (/^classDef\s+/i.test(line)) continue;

            // class assignment: class N1,N2 srv;
            const classMatch = line.match(/^class\s+(.+?)\s+(\w+)\s*;?\s*$/);
            if (classMatch) {
                const ids = classMatch[1].split(',').map(s => s.trim());
                const cls = classMatch[2];
                ids.forEach(id => { classAssignments[id] = cls; });
                continue;
            }

            // Inline definitions with connection: A["label"] --> B["label"]
            // or simple connections: A --> B, A -->|label| B
            if (line.includes('-->')) {
                const parts = line.split(/\s*-->(?:\|([^|]*)\|)?\s*/);
                if (parts.length >= 2) {
                    const segments = [];
                    const labels = [];
                    // Re-parse to get labels from the split
                    const labelRegex = /-->(?:\|([^|]*)\|)?/g;
                    let lm;
                    while ((lm = labelRegex.exec(line)) !== null) {
                        labels.push((lm[1] || '').trim());
                    }

                    // Extract each segment (could be "ID" or "ID[...]" etc.)
                    const segmentRegex = /(?:^|-->[^>]*?\s*)(\w+(?:\s*(?:\(\([^)]*\)\)|\{\s*[^}]*\s*\}|\[\[[^\]]*\]\]|\[[^\]]*\]))?\s*)/g;
                    const rawSegments = line.split(/\s*-->(?:\|[^|]*\|)?\s*/);

                    rawSegments.forEach(seg => {
                        const trimmed = seg.trim();
                        if (!trimmed) return;
                        const idOnly = trimmed.match(/^(\w+)/);
                        if (idOnly) {
                            parseNodeDef(trimmed, parsedNodes);
                            segments.push(idOnly[1]);
                        }
                    });

                    for (let s = 0; s < segments.length - 1; s++) {
                        parsedEdges.push({
                            from: segments[s],
                            to: segments[s + 1],
                            label: labels[s] || ''
                        });
                    }
                    continue;
                }
            }

            // Node definitions (standalone)
            parseNodeDef(line, parsedNodes);
        }

        // Also extract nodes from edges that may not have explicit definitions
        parsedEdges.forEach(e => {
            if (!parsedNodes[e.from]) parsedNodes[e.from] = { id: e.from, label: e.from, shape: 'rect' };
            if (!parsedNodes[e.to]) parsedNodes[e.to] = { id: e.to, label: e.to, shape: 'rect' };
        });

        // Determine node type from class assignments, label prefix, or shape
        const resolvedNodes = {};
        for (const [id, info] of Object.entries(parsedNodes)) {
            const cls = classAssignments[id];
            const type = resolveNodeType(cls, info.label, info.shape);
            resolvedNodes[id] = { ...info, type };
        }

        // Clear existing canvas
        clearCanvas();

        // Layout: topological sort for vertical flow, then spread horizontally per level
        const nodeIds = Object.keys(resolvedNodes);
        const levels = computeLevels(nodeIds, parsedEdges);
        const spacingX = 240;
        const spacingY = 150;
        const offsetX = 100;
        const offsetY = 80;

        const idMap = {};

        nodeIds.forEach((origId) => {
            const info = resolvedNodes[origId];
            const pos = levels[origId] || { row: 0, col: 0 };
            const x = offsetX + pos.col * spacingX;
            const y = offsetY + pos.row * spacingY;

            const newId = 'n' + (++nodeIdCounter);
            idMap[origId] = newId;

            const node = { id: newId, type: info.type, name: info.label, x, y };
            nodes.push(node);
            renderNode(node);
        });

        // Create edges
        parsedEdges.forEach(pe => {
            const fromId = idMap[pe.from];
            const toId = idMap[pe.to];
            if (fromId && toId) {
                addEdge(fromId, toId, pe.label);
            }
        });

        updatePlaceholder();
    }

    function parseNodeDef(segment, parsedNodes) {
        const s = segment.trim();

        // (("label")) - circle (start/end)
        let m = s.match(/^(\w+)\s*\(\(\s*"([^"]*)"\s*\)\)/);
        if (m) { parsedNodes[m[1]] = { id: m[1], label: m[2], shape: 'circle' }; return; }
        m = s.match(/^(\w+)\s*\(\(\s*([^)]*?)\s*\)\)/);
        if (m) { parsedNodes[m[1]] = { id: m[1], label: m[2], shape: 'circle' }; return; }

        // {"label"} - diamond (decision)
        m = s.match(/^(\w+)\s*\{\s*"([^"]*)"\s*\}/);
        if (m) { parsedNodes[m[1]] = { id: m[1], label: m[2], shape: 'diamond' }; return; }
        m = s.match(/^(\w+)\s*\{\s*([^}]*?)\s*\}/);
        if (m) { parsedNodes[m[1]] = { id: m[1], label: m[2], shape: 'diamond' }; return; }

        // [["label"]] - subroutine (sub)
        m = s.match(/^(\w+)\s*\[\[\s*"([^"]*)"\s*\]\]/);
        if (m) { parsedNodes[m[1]] = { id: m[1], label: m[2], shape: 'subroutine' }; return; }
        m = s.match(/^(\w+)\s*\[\[\s*([^\]]*?)\s*\]\]/);
        if (m) { parsedNodes[m[1]] = { id: m[1], label: m[2], shape: 'subroutine' }; return; }

        // ["label"] - rectangle
        m = s.match(/^(\w+)\s*\[\s*"([^"]*)"\s*\]/);
        if (m) { parsedNodes[m[1]] = { id: m[1], label: m[2], shape: 'rect' }; return; }
        m = s.match(/^(\w+)\s*\[\s*([^\]]*?)\s*\]/);
        if (m) { parsedNodes[m[1]] = { id: m[1], label: m[2], shape: 'rect' }; return; }

        // Bare ID without shape definition
        m = s.match(/^(\w+)\s*$/);
        if (m && !parsedNodes[m[1]]) {
            parsedNodes[m[1]] = { id: m[1], label: m[1], shape: 'rect' };
        }
    }

    function resolveNodeType(classAssignment, label, shape) {
        // Priority 1: explicit class assignment
        if (classAssignment) {
            const map = { srv: 'srv', paso: 'paso', err: 'err', sub: 'sub', decision: 'start', fin: 'end' };
            if (map[classAssignment]) {
                if (classAssignment === 'decision' && shape === 'diamond') return 'decision';
                if (classAssignment === 'decision' && shape === 'circle') return 'start';
                return map[classAssignment];
            }
        }

        // Priority 2: label prefix
        if (label.startsWith('srv.')) return 'srv';
        if (label.startsWith('paso.')) return 'paso';
        if (label.startsWith('err.')) return 'err';
        if (label.startsWith('sub.')) return 'sub';

        // Priority 3: shape
        if (shape === 'diamond') return 'decision';
        if (shape === 'circle') {
            const lower = label.toLowerCase();
            if (lower === 'fin' || lower === 'end') return 'end';
            return 'start';
        }
        if (shape === 'subroutine') return 'sub';

        // Priority 4: keyword in label
        const lower = label.toLowerCase();
        if (lower.includes('inicio') || lower === 'start') return 'start';
        if (lower === 'fin' || lower === 'end') return 'end';
        if (lower.includes('error')) return 'err';

        return 'paso';
    }

    function computeLevels(nodeIds, edgeList) {
        const inDegree = {};
        const children = {};
        nodeIds.forEach(id => { inDegree[id] = 0; children[id] = []; });
        edgeList.forEach(e => {
            if (inDegree[e.to] !== undefined) inDegree[e.to]++;
            if (children[e.from]) children[e.from].push(e.to);
        });

        // BFS topological
        const queue = nodeIds.filter(id => inDegree[id] === 0);
        const rowOf = {};
        queue.forEach(id => { rowOf[id] = 0; });

        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++];
            (children[cur] || []).forEach(child => {
                rowOf[child] = Math.max(rowOf[child] || 0, rowOf[cur] + 1);
                inDegree[child]--;
                if (inDegree[child] === 0) queue.push(child);
            });
        }

        // Assign remaining unvisited nodes (cycles or isolates)
        let maxRow = 0;
        nodeIds.forEach(id => {
            if (rowOf[id] === undefined) rowOf[id] = 0;
            maxRow = Math.max(maxRow, rowOf[id]);
        });

        // Group by row and assign columns
        const rowGroups = {};
        nodeIds.forEach(id => {
            const r = rowOf[id];
            if (!rowGroups[r]) rowGroups[r] = [];
            rowGroups[r].push(id);
        });

        const result = {};
        for (const [row, ids] of Object.entries(rowGroups)) {
            ids.forEach((id, col) => {
                result[id] = { row: parseInt(row), col };
            });
        }
        return result;
    }

    // Init mermaid (for preview)
    mermaid.initialize({ startOnLoad: false, theme: 'default' });

    // ─── Confluence Integration ───

    const API_BASE = window.location.origin + '/api';
    let lastLoadedPageId = null;

    // Tab switching
    document.querySelectorAll('.confluence-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.confluence-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.confluence-tab-content').forEach(c => {
                c.classList.remove('active');
                c.style.display = 'none';
            });
            tab.classList.add('active');
            const target = document.getElementById('tab-' + tab.dataset.tab);
            if (target) {
                target.classList.add('active');
                target.style.display = 'block';
            }
        });
    });

    // Open load modal
    document.getElementById('btn-confluence-load').addEventListener('click', () => {
        hideStatus('confluence-load-status');
        document.getElementById('modal-confluence-load').style.display = 'flex';
    });

    // Close load modal
    ['modal-confluence-load-close', 'modal-confluence-load-cancel'].forEach(id => {
        document.getElementById(id).addEventListener('click', () => {
            document.getElementById('modal-confluence-load').style.display = 'none';
        });
    });

    // Search in Confluence
    document.getElementById('btn-confluence-search').addEventListener('click', async () => {
        const query = document.getElementById('confluence-search-query').value.trim();
        if (!query) { showToast('Escribí un texto para buscar'); return; }

        const resultsDiv = document.getElementById('confluence-search-results');
        resultsDiv.innerHTML = '<div class="search-loading">Buscando...</div>';

        try {
            const resp = await fetch(API_BASE + '/confluence/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query }),
            });
            const data = await resp.json();

            if (!data.results || data.results.length === 0) {
                resultsDiv.innerHTML = '<div class="search-empty">No se encontraron resultados</div>';
                return;
            }

            resultsDiv.innerHTML = data.results.map(r => `
                <div class="search-result-item" data-page-id="${r.id}">
                    <div class="search-result-title">${escapeHtml(r.title)}</div>
                    <div class="search-result-meta">ID: ${r.id} · Space: ${r.space}</div>
                </div>
            `).join('');

            resultsDiv.querySelectorAll('.search-result-item').forEach(item => {
                item.addEventListener('click', () => {
                    resultsDiv.querySelectorAll('.search-result-item').forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    document.getElementById('confluence-page-id').value = item.dataset.pageId;
                    // Switch to "by-id" tab with the selected ID
                    document.querySelectorAll('.confluence-tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.confluence-tab-content').forEach(c => {
                        c.classList.remove('active');
                        c.style.display = 'none';
                    });
                    const byIdTab = document.querySelector('[data-tab="by-id"]');
                    byIdTab.classList.add('active');
                    document.getElementById('tab-by-id').style.display = 'block';
                    document.getElementById('tab-by-id').classList.add('active');
                    showStatus('confluence-load-status', 'info', `Página seleccionada: ${escapeHtml(item.querySelector('.search-result-title').textContent)} (${item.dataset.pageId})`);
                });
            });
        } catch (err) {
            resultsDiv.innerHTML = `<div class="search-error">Error: ${err.message}</div>`;
        }
    });

    document.getElementById('confluence-search-query').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('btn-confluence-search').click();
    });

    // Fetch page and extract Mermaid
    document.getElementById('btn-confluence-fetch').addEventListener('click', async () => {
        const activeTab = document.querySelector('.confluence-tab.active');
        const tab = activeTab ? activeTab.dataset.tab : 'by-id';

        let body = {};
        if (tab === 'by-id') {
            const pageId = document.getElementById('confluence-page-id').value.trim();
            if (!pageId) { showToast('Ingresá el ID de la página'); return; }
            body = { page_id: pageId };
        } else if (tab === 'by-title') {
            const spaceKey = document.getElementById('confluence-space-key').value.trim();
            const title = document.getElementById('confluence-page-title').value.trim();
            if (!spaceKey || !title) { showToast('Completá space key y título'); return; }
            body = { title, space_key: spaceKey };
        } else {
            showToast('Seleccioná una página de los resultados');
            return;
        }

        showStatus('confluence-load-status', 'loading', 'Conectando con Confluence...');

        try {
            const resp = await fetch(API_BASE + '/confluence/get-page', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await resp.json();

            if (!resp.ok) {
                showStatus('confluence-load-status', 'error', `Error ${resp.status}: ${data.detail || 'Error desconocido'}`);
                return;
            }

            if (!data.has_mermaid || !data.mermaid_code) {
                showStatus('confluence-load-status', 'warning', `Página "${data.title}" encontrada pero no contiene diagrama Mermaid.`);
                return;
            }

            showStatus('confluence-load-status', 'success', `Diagrama encontrado en "${data.title}" (v${data.version}). Importando...`);
            lastLoadedPageId = data.id;

            setTimeout(() => {
                try {
                    importMermaidCode(data.mermaid_code);
                    document.getElementById('modal-confluence-load').style.display = 'none';
                    document.getElementById('publish-page-id').value = data.id;
                    showToast(`Diagrama importado desde "${data.title}"`);
                } catch (err) {
                    showStatus('confluence-load-status', 'error', 'Error al parsear el diagrama: ' + err.message);
                }
            }, 600);
        } catch (err) {
            showStatus('confluence-load-status', 'error', 'Error de conexión: ' + err.message);
        }
    });

    // Open publish modal
    document.getElementById('btn-confluence-publish').addEventListener('click', () => {
        if (nodes.length === 0) {
            showToast('No hay diagrama para publicar');
            return;
        }
        hideStatus('confluence-publish-status');
        if (lastLoadedPageId) {
            document.getElementById('publish-page-id').value = lastLoadedPageId;
        }
        document.getElementById('modal-confluence-publish').style.display = 'flex';
    });

    // Close publish modal
    ['modal-confluence-publish-close', 'modal-confluence-publish-cancel'].forEach(id => {
        document.getElementById(id).addEventListener('click', () => {
            document.getElementById('modal-confluence-publish').style.display = 'none';
        });
    });

    // Do publish
    document.getElementById('btn-confluence-do-publish').addEventListener('click', async () => {
        const pageId = document.getElementById('publish-page-id').value.trim();
        const sectionTitle = document.getElementById('publish-section-title').value.trim() || 'Flujo de negocio';

        if (!pageId) { showToast('Ingresá el ID de la página destino'); return; }

        const mermaidCode = generateMermaidCode();
        if (nodes.length === 0) { showToast('No hay diagrama para publicar'); return; }

        showStatus('confluence-publish-status', 'loading', 'Publicando en Confluence...');

        try {
            const resp = await fetch(API_BASE + '/confluence/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    page_id: pageId,
                    mermaid_code: mermaidCode,
                    section_title: sectionTitle,
                }),
            });
            const data = await resp.json();

            if (!resp.ok) {
                showStatus('confluence-publish-status', 'error', `Error ${resp.status}: ${data.detail || 'Error al publicar'}`);
                return;
            }

            showStatus('confluence-publish-status', 'success',
                `Publicado exitosamente (v${data.version}). <a href="${data.url}" target="_blank" rel="noopener">Ver en Confluence →</a>`
            );
            lastLoadedPageId = pageId;
        } catch (err) {
            showStatus('confluence-publish-status', 'error', 'Error de conexión: ' + err.message);
        }
    });

    // ── Status helpers ──

    function showStatus(elementId, type, message) {
        const el = document.getElementById(elementId);
        el.style.display = 'block';
        el.className = 'confluence-status confluence-status--' + type;
        el.innerHTML = message;
    }

    function hideStatus(elementId) {
        const el = document.getElementById(elementId);
        el.style.display = 'none';
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

})();
