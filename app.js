// DOM Elements
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const cameraBtn = document.getElementById('cameraBtn');
const progressSection = document.getElementById('progressSection');
const sessionIdSpan = document.getElementById('sessionId');
const progressText = document.getElementById('progressText');
const compressionInfo = document.getElementById('compressionInfo');
const chunkGrid = document.getElementById('chunkGrid');
const resultSection = document.getElementById('resultSection');
const resultText = document.getElementById('resultText');
const resultStats = document.getElementById('resultStats');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const errorSection = document.getElementById('errorSection');
const errorMessage = document.getElementById('errorMessage');
const scanFrame = document.getElementById('scanFrame');
const scanOutline = document.getElementById('scanOutline');
const scanStatus = document.getElementById('scanStatus');
const scanLamp = document.getElementById('scanLamp');
const scanState = document.getElementById('scanState');
const scanRate = document.getElementById('scanRate');

// State
let stream = null;
let scanning = false;
let currentSession = null;
let receivedChunks = new Map();
let totalChunks = 0;
let isCompressed = false;
let animationId = null;
let pendingFile = null; // set when the received payload is a wrapped file
// Scan dial-in feedback
let decodeTimes = [];   // timestamps of successful decodes (1s sliding window)
let lastDecodeAt = 0;
let emaCorners = null;  // smoothed detected QR corners (normalised 0..1) for the outline
let decoderBusy = false;
let zxing = null, zxingReady = false; // ZXing-wasm: stronger decoder than jsQR
const LOCK_MS = 700;    // how long "LOCKED" lingers after the last decode

// Initialize
function init() {
    loadDecoder();
    cameraBtn.addEventListener('click', toggleCamera);
    copyBtn.addEventListener('click', copyResult);
    saveBtn.addEventListener('click', saveResult);
    resetBtn.addEventListener('click', reset);

    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('SW registered:', reg.scope))
            .catch(err => console.log('SW registration failed:', err));
    }
}

// Camera handling
async function toggleCamera() {
    if (stream) {
        stopCamera();
    } else {
        await startCamera();
    }
}

async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1920 },
                height: { ideal: 1920 },
                frameRate: { ideal: 30 }
            }
        });
        video.srcObject = stream;
        await video.play();

        cameraBtn.textContent = 'Stop Camera';
        cameraBtn.classList.add('active');

        resetScanFeedback();
        scanStatus.classList.remove('hidden');

        scanning = true;
        scan();

        hideError();
    } catch (err) {
        showError('Camera access denied. Please allow camera permissions.');
        console.error('Camera error:', err);
    }
}

function stopCamera() {
    scanning = false;
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    video.srcObject = null;
    cameraBtn.textContent = 'Start Camera';
    cameraBtn.classList.remove('active');
    scanStatus.classList.add('hidden');
    resetScanFeedback();
}

// Load the strong decoder (ZXing-C++ compiled to WASM). Falls back to jsQR if it
// can't load. Cached by the service worker after first online load, so works offline.
async function loadDecoder() {
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/zxing-wasm@2/+esm');
        try { await mod.readBarcodes(new ImageData(2, 2), { formats: ['QRCode'] }); } catch (e) {} // warm wasm
        zxing = mod;
        zxingReady = true;
        console.log('Decoder: ZXing-wasm ready');
    } catch (e) {
        zxingReady = false;
        console.log('Decoder: ZXing load failed, using jsQR fallback', e);
    }
}

// Decode one frame -> { text, corners:{tl,tr,br,bl} in pixel space } or null
async function decodeFrame(imageData) {
    if (zxingReady && zxing) {
        try {
            const res = await zxing.readBarcodes(imageData, { tryHarder: true, formats: ['QRCode'], maxNumberOfSymbols: 1 });
            if (res && res.length && res[0].text) {
                const p = res[0].position;
                return { text: res[0].text, corners: { tl: p.topLeft, tr: p.topRight, br: p.bottomRight, bl: p.bottomLeft } };
            }
            return null;
        } catch (e) { /* fall through to jsQR */ }
    }
    const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
    if (code) {
        const l = code.location;
        return { text: code.data, corners: { tl: l.topLeftCorner, tr: l.topRightCorner, br: l.bottomRightCorner, bl: l.bottomLeftCorner } };
    }
    return null;
}

function normalizeCorners(c, w, h) {
    return {
        tl: { x: c.tl.x / w, y: c.tl.y / h }, tr: { x: c.tr.x / w, y: c.tr.y / h },
        br: { x: c.br.x / w, y: c.br.y / h }, bl: { x: c.bl.x / w, y: c.bl.y / h }
    };
}

// QR Scanning
function scan() {
    if (!scanning) return;
    const now = performance.now();

    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth && !decoderBusy) {
        // Size the work canvas to the live frame EVERY time — fixes the 0x0 case
        // when the camera wasn't ready at start (decoder looked dead, read nothing)
        if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const dw = canvas.width, dh = canvas.height;

        decoderBusy = true;
        decodeFrame(imageData).then(result => {
            decoderBusy = false;
            if (!scanning || !result) return;
            const t = performance.now();
            processQRCode(result.text);
            decodeTimes.push(t);
            lastDecodeAt = t;
            updateOutline(normalizeCorners(result.corners, dw, dh));
        }).catch(() => { decoderBusy = false; });
    }

    while (decodeTimes.length && now - decodeTimes[0] > 1000) decodeTimes.shift();
    updateScanFeedback(now);

    animationId = requestAnimationFrame(scan);
}

// --- Dial-in feedback: lock lamp, reads/sec, positional guidance, live outline ---
function updateScanFeedback(now) {
    const locked = (now - lastDecodeAt) < LOCK_MS;
    scanFrame.classList.toggle('locked', locked);
    scanLamp.classList.toggle('on', locked);
    if (locked) {
        scanState.textContent = 'LOCKED';
        scanRate.textContent = decodeTimes.length + ' reads/sec';
    } else {
        scanState.textContent = 'Searching…';
        scanRate.textContent = emaCorners ? positionHint() : 'line up the QR';
    }
    drawOutline(locked);
}

// Use the last detected QR location to nudge the user toward a better position
function positionHint() {
    const c = emaCorners; // normalised 0..1
    const w = Math.hypot(c.tr.x - c.tl.x, c.tr.y - c.tl.y);
    if (w < 0.30) return 'move closer to the box';
    if (w > 0.92) return 'move back a little';
    const cx = (c.tl.x + c.tr.x + c.br.x + c.bl.x) / 4;
    const cy = (c.tl.y + c.tr.y + c.br.y + c.bl.y) / 4;
    const dx = cx - 0.5, dy = cy - 0.5;
    if (Math.abs(dx) > 0.18 || Math.abs(dy) > 0.18) {
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right ▶' : '◀ left') : (dy > 0 ? 'down ▼' : '▲ up');
        return 'aim ' + dir;
    }
    return 're-aim to the box';
}

function updateOutline(n) {
    // n: corners normalised 0..1 (decoder-resolution independent)
    if (!emaCorners) {
        emaCorners = { tl:{x:n.tl.x,y:n.tl.y}, tr:{x:n.tr.x,y:n.tr.y}, br:{x:n.br.x,y:n.br.y}, bl:{x:n.bl.x,y:n.bl.y} };
    } else {
        const a = 0.5; // smoothing so the box doesn't jitter
        ['tl','tr','br','bl'].forEach(k => {
            emaCorners[k].x = emaCorners[k].x * (1 - a) + n[k].x * a;
            emaCorners[k].y = emaCorners[k].y * (1 - a) + n[k].y * a;
        });
    }
}

function drawOutline(locked) {
    // Size the overlay to its displayed CSS box, then map normalised QR coords into it
    // using the SAME object-fit:cover math the <video> uses (explicit = reliable on iOS).
    const cw = scanOutline.clientWidth, ch = scanOutline.clientHeight;
    if (!cw || !ch) return;
    if (scanOutline.width !== cw) scanOutline.width = cw;
    if (scanOutline.height !== ch) scanOutline.height = ch;
    const octx = scanOutline.getContext('2d');
    octx.clearRect(0, 0, cw, ch);
    if (!emaCorners || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(cw / vw, ch / vh);              // cover scale
    const dispW = vw * s, dispH = vh * s;
    const ox = (cw - dispW) / 2, oy = (ch - dispH) / 2;
    const m = p => [p.x * dispW + ox, p.y * dispH + oy]; // p normalised 0..1
    const tl = m(emaCorners.tl), tr = m(emaCorners.tr), br = m(emaCorners.br), bl = m(emaCorners.bl);
    octx.lineWidth = Math.max(3, cw * 0.013);
    octx.lineJoin = 'round';
    // bright when locked; dim but still visible as a re-aim guide after lock is lost
    octx.strokeStyle = locked ? '#00ff88' : 'rgba(0,255,136,0.55)';
    octx.shadowColor = '#00ff88';
    octx.shadowBlur = locked ? 14 : 6;
    octx.beginPath();
    octx.moveTo(tl[0], tl[1]);
    octx.lineTo(tr[0], tr[1]);
    octx.lineTo(br[0], br[1]);
    octx.lineTo(bl[0], bl[1]);
    octx.closePath();
    octx.stroke();
}

function resetScanFeedback() {
    decodeTimes = [];
    lastDecodeAt = 0;
    emaCorners = null;
    if (scanOutline.width) scanOutline.getContext('2d').clearRect(0, 0, scanOutline.width, scanOutline.height);
    scanFrame.classList.remove('locked');
    scanLamp.classList.remove('on');
    scanState.textContent = 'Searching…';
    scanRate.textContent = '';
}

function processQRCode(data) {
    try {
        const payload = JSON.parse(data);

        // Validate payload structure
        if (!payload.v || !payload.id || payload.i === undefined || !payload.t || !payload.d) {
            return; // Invalid payload, skip
        }

        // Check protocol version
        if (payload.v !== 1) {
            showError(`Unsupported protocol version: ${payload.v}`);
            return;
        }

        // New session?
        if (currentSession !== payload.id) {
            startNewSession(payload.id, payload.t, payload.c || false);
        }

        // Store chunk if not already received
        if (!receivedChunks.has(payload.i)) {
            receivedChunks.set(payload.i, payload.d);
            updateProgress(payload.i);

            // Check if complete
            if (receivedChunks.size === totalChunks) {
                completeTransfer();
            }
        }
    } catch (err) {
        // Not a valid JSON QR code, ignore
    }
}

function startNewSession(id, total, compressed) {
    currentSession = id;
    totalChunks = total;
    isCompressed = compressed;
    receivedChunks.clear();

    // Update UI
    sessionIdSpan.textContent = id;
    progressText.textContent = `0/${total}`;

    if (compressed) {
        compressionInfo.classList.remove('hidden');
    } else {
        compressionInfo.classList.add('hidden');
    }

    // Build chunk grid
    chunkGrid.innerHTML = '';
    for (let i = 0; i < total; i++) {
        const chunk = document.createElement('div');
        chunk.className = 'chunk';
        chunk.id = `chunk-${i}`;
        chunk.textContent = i + 1;
        chunkGrid.appendChild(chunk);
    }

    progressSection.classList.remove('hidden');
    resultSection.classList.add('hidden');
}

function updateProgress(index) {
    const chunk = document.getElementById(`chunk-${index}`);
    if (chunk) {
        chunk.classList.add('received');
    }
    progressText.textContent = `${receivedChunks.size}/${totalChunks}`;
}

function completeTransfer() {
    stopCamera();

    try {
        // Reassemble chunks in order
        let base64Data = '';
        for (let i = 0; i < totalChunks; i++) {
            base64Data += receivedChunks.get(i);
        }

        // Decode base64 to bytes
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Decompress if needed
        let finalBytes = bytes;
        if (isCompressed) {
            try {
                finalBytes = pako.inflate(bytes);
            } catch (err) {
                showError('Decompression failed: ' + err.message);
                return;
            }
        }

        // File transfer? ('QRF1' magic + 2-byte header len + JSON{n,m} header + file bytes)
        if (finalBytes.length > 6 &&
            finalBytes[0] === 0x51 && finalBytes[1] === 0x52 &&
            finalBytes[2] === 0x46 && finalBytes[3] === 0x31) {
            const hdrLen = (finalBytes[4] << 8) | finalBytes[5];
            const meta = JSON.parse(new TextDecoder().decode(finalBytes.subarray(6, 6 + hdrLen)));
            const body = finalBytes.slice(6 + hdrLen);
            showFile(meta.n || 'file.bin', meta.m || 'application/octet-stream', body);
            return;
        }

        // Decode to text
        const decoder = new TextDecoder();
        const text = decoder.decode(finalBytes);

        // Display result
        resultText.textContent = text;
        resultStats.textContent = `${text.length} characters`;
        resultSection.classList.remove('hidden');

        // Keep progress visible
        progressSection.classList.remove('hidden');

    } catch (err) {
        showError('Failed to decode data: ' + err.message);
    }
}

// Received a file: show it at the bottom with a Save button (binary-safe)
function showFile(name, type, bytes) {
    pendingFile = { name, type, bytes };
    resultText.textContent = `📎 ${name}\n${bytes.length} bytes` + (type ? `\n${type}` : '');
    resultStats.textContent = `${bytes.length} bytes`;
    copyBtn.classList.add('hidden');   // copy is meaningless for binary
    saveBtn.textContent = 'Save File';
    resultSection.classList.remove('hidden');
    progressSection.classList.remove('hidden');
}

// Result handling
async function copyResult() {
    const text = resultText.textContent;
    try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
            copyBtn.textContent = 'Copy All';
            copyBtn.classList.remove('copied');
        }, 2000);
    } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            copyBtn.textContent = 'Copied!';
            copyBtn.classList.add('copied');
            setTimeout(() => {
                copyBtn.textContent = 'Copy All';
                copyBtn.classList.remove('copied');
            }, 2000);
        } catch (e) {
            showError('Failed to copy to clipboard');
        }
        document.body.removeChild(textarea);
    }
}

function saveResult() {
    let blob, filename, btnLabel;
    if (pendingFile) {
        blob = new Blob([pendingFile.bytes], { type: pendingFile.type });
        filename = pendingFile.name;
        btnLabel = 'Save File';
    } else {
        blob = new Blob([resultText.textContent], { type: 'text/plain' });
        filename = `qr-scan-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
        btnLabel = 'Save .txt';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    saveBtn.textContent = 'Saved!';
    setTimeout(() => { saveBtn.textContent = btnLabel; }, 2000);
}

function reset() {
    currentSession = null;
    receivedChunks.clear();
    totalChunks = 0;
    isCompressed = false;
    pendingFile = null;

    progressSection.classList.add('hidden');
    resultSection.classList.add('hidden');
    hideError();

    chunkGrid.innerHTML = '';
    resultText.textContent = '';
    copyBtn.classList.remove('hidden');
    saveBtn.textContent = 'Save .txt';
    resetScanFeedback();
}

// Error handling
function showError(message) {
    errorMessage.textContent = message;
    errorSection.classList.remove('hidden');
}

function hideError() {
    errorSection.classList.add('hidden');
}

// Start
init();
